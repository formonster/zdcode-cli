import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Command } from 'commander'
import { readZdcodeEnv, ZDCODE_ENV_PATH } from '../../utils/zdcode-env'

const DEFAULT_API_URL = 'https://api.kkrich.ltd'
const DEFAULT_MODEL = 'sd_2.0_fast_special_720p'
const DEFAULT_SECONDS = 4
const DEFAULT_POLL_INTERVAL_SECONDS = 12
const DEFAULT_TIMEOUT_SECONDS = 30 * 60
const RESPONSE_PREVIEW_LIMIT = 2000

type VideoOptions = {
  seconds: string
  audio: boolean
  out?: string
  referenceVideo?: string
  apiUrl?: string
  model?: string
  taskId?: string
  pollInterval: string
  timeout: string
}

type ApiError = {
  code?: string
  message?: string
}

type VideoTask = {
  id?: string
  task_id?: string
  status?: string
  url?: string
  error?: ApiError | string | null
}

type VideoApiResponse = VideoTask & {
  data?: VideoTask
  detail?: string
  message?: string
  error?: ApiError | string | null
}

class VideoQueryNetworkError extends Error {}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const previewText = (text: string) => {
  const value = text.trim()
  if (!value) return '<empty>'
  return value.length > RESPONSE_PREVIEW_LIMIT
    ? `${value.slice(0, RESPONSE_PREVIEW_LIMIT)}...`
    : value
}

const parseJson = (text: string) => {
  if (!text.trim()) return {}
  try {
    return JSON.parse(text) as VideoApiResponse
  } catch {
    return undefined
  }
}

const formatTaskError = (error: VideoTask['error']) => {
  if (!error) return 'Unknown video generation error.'
  if (typeof error === 'string') return error
  const details = [error.code, error.message].filter(Boolean)
  return details.length ? details.join(': ') : JSON.stringify(error)
}

const apiErrorMessage = (operation: string, response: Response, text: string, payload?: VideoApiResponse) => {
  const payloadError = payload?.error
  const message = typeof payloadError === 'string'
    ? payloadError
    : payloadError?.message || payload?.detail || payload?.message

  if (message) return `${operation}: ${message}`

  return [
    `${operation}: ${response.status} ${response.statusText}`,
    `content-type: ${response.headers.get('content-type') || 'unknown'}`,
    `response body: ${previewText(text)}`,
  ].join('\n')
}

const readJsonResponse = async (operation: string, response: Response) => {
  const text = await response.text()
  const payload = parseJson(text)
  if (!response.ok) throw new Error(apiErrorMessage(operation, response, text, payload))
  if (!payload) throw new Error(apiErrorMessage(operation, response, text))
  return payload
}

const normalizeApiUrl = (value: string) => {
  const url = value.trim().replace(/\/+$/, '')
  if (url.endsWith('/video/generations')) return url
  if (url.endsWith('/v1')) return `${url}/video/generations`
  return `${url}/v1/video/generations`
}

const positiveInteger = (value: string, name: string) => {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

const videoConfig = (options: VideoOptions) => {
  const env = readZdcodeEnv()
  return {
    apiKey: env.VIDEO_API_KEY,
    apiUrl: normalizeApiUrl(options.apiUrl || env.VIDEO_API_URL || DEFAULT_API_URL),
    model: options.model || env.VIDEO_MODEL || DEFAULT_MODEL,
  }
}

const submitTask = async (
  apiUrl: string,
  apiKey: string,
  prompt: string,
  options: VideoOptions,
  seconds: number,
  model: string,
) => {
  const body: Record<string, unknown> = {
    model,
    prompt,
    seconds: String(seconds),
    generate_audio: options.audio,
  }
  if (options.referenceVideo) body.reference_video = options.referenceVideo

  let response: Response
  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new Error(`Video task submission failed before response: ${error instanceof Error ? error.message : String(error)}`)
  }

  const task = await readJsonResponse('Video task submission failed', response)
  const taskId = task.id || task.task_id
  if (!taskId) throw new Error(`Video task submission succeeded without a task ID: ${JSON.stringify(task)}`)
  return taskId
}

const queryTask = async (apiUrl: string, apiKey: string, taskId: string) => {
  let response: Response
  try {
    response = await fetch(`${apiUrl}/${encodeURIComponent(taskId)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    })
  } catch (error) {
    throw new VideoQueryNetworkError(error instanceof Error ? error.message : String(error))
  }
  const body = await readJsonResponse('Video task query failed', response)
  return body.data || body
}

const downloadVideo = async (url: string, apiKey: string, filePath: string) => {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${apiKey}` },
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(apiErrorMessage('Video download failed', response, text, parseJson(text)))
  }
  if (!response.body) throw new Error('Video download failed: response body is empty')

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.part-${process.pid}`
  try {
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      fs.createWriteStream(temporaryPath),
    )
    fs.renameSync(temporaryPath, filePath)
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true })
    throw error
  }
}

const validateReferenceVideo = (model: string, referenceVideo?: string) => {
  const requiresReference = model.endsWith('_with_video_ref')
  if (requiresReference && !referenceVideo) {
    throw new Error(`Model ${model} requires --reference-video`)
  }
  if (!referenceVideo) return
  if (!requiresReference) {
    throw new Error(`Model ${model} does not accept --reference-video; use a _with_video_ref model`)
  }

  let url: URL
  try {
    url = new URL(referenceVideo)
  } catch {
    throw new Error('reference video must be a public HTTPS URL')
  }
  if (url.protocol !== 'https:') throw new Error('reference video must be a public HTTPS URL')
}

const waitForTask = async (
  apiUrl: string,
  apiKey: string,
  taskId: string,
  options: VideoOptions,
) => {
  const pollInterval = positiveInteger(options.pollInterval, 'poll interval')
  const timeout = positiveInteger(options.timeout, 'timeout')
  const deadline = Date.now() + timeout * 1000

  while (Date.now() < deadline) {
    let task: VideoTask
    try {
      task = await queryTask(apiUrl, apiKey, taskId)
    } catch (error) {
      if (!(error instanceof VideoQueryNetworkError)) throw error
      console.error(`Video task ${taskId} query network error; retrying the same task: ${error.message}`)
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await sleep(Math.min(pollInterval * 1000, remaining))
      continue
    }
    const status = task.status
    if (status === 'succeeded' || status === 'completed') {
      if (!task.url) throw new Error(`Video task ${taskId} succeeded without a video URL.`)
      const filePath = path.resolve(options.out || `seedance-${taskId}.mp4`)
      await downloadVideo(task.url, apiKey, filePath)
      console.log(`video_url=${task.url}`)
      console.log(`✅ Video written: ${filePath}`)
      return
    }
    if (status === 'failed') {
      throw new Error(`Video task ${taskId} failed: ${formatTaskError(task.error)}`)
    }
    if (status !== 'queued' && status !== 'processing' && status !== 'in_progress') {
      throw new Error(`Video task ${taskId} returned unknown status: ${status || '<empty>'}`)
    }

    console.log(`Video task ${taskId}: ${status}`)
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await sleep(Math.min(pollInterval * 1000, remaining))
  }

  throw new Error(`Video task ${taskId} did not finish within ${timeout} seconds. Resume with: zdcode video --task-id ${taskId}`)
}

const generateVideo = async (prompt: string | undefined, options: VideoOptions) => {
  const config = videoConfig(options)
  if (!config.apiKey) throw new Error(`Missing VIDEO_API_KEY in ${ZDCODE_ENV_PATH}`)

  let taskId = options.taskId
  if (!taskId) {
    if (!prompt?.trim()) throw new Error('prompt is required when --task-id is not provided')
    const seconds = positiveInteger(options.seconds, 'seconds')
    if (seconds < 4 || seconds > 15) throw new Error('seconds must be between 4 and 15')
    validateReferenceVideo(config.model, options.referenceVideo)
    taskId = await submitTask(config.apiUrl, config.apiKey, prompt, options, seconds, config.model)
    console.log(`task_id=${taskId}`)
  }

  await waitForTask(config.apiUrl, config.apiKey, taskId, options)
}

const registerVideoModule = (program: Command) => {
  program
    .command('video [prompt]')
    .description('生成视频，或使用 --task-id 继续查询已有任务')
    .option('--seconds <seconds>', '视频时长，4-15 秒', String(DEFAULT_SECONDS))
    .option('--no-audio', '生成静音视频')
    .option('-o, --out <path>', '输出视频路径')
    .option('--reference-video <url>', '参考视频的公网 HTTPS 直链')
    .option('--api-url <url>', '视频接口 URL 或 base URL')
    .option('--model <model>', 'Seedance 模型')
    .option('--task-id <taskId>', '跳过付费提交，继续查询已有任务')
    .option('--poll-interval <seconds>', '查询间隔秒数', String(DEFAULT_POLL_INTERVAL_SECONDS))
    .option('--timeout <seconds>', '最长等待秒数', String(DEFAULT_TIMEOUT_SECONDS))
    .action(async (prompt: string | undefined, options: VideoOptions) => {
      try {
        await generateVideo(prompt, options)
      } catch (error) {
        console.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
      }
    })
}

export default registerVideoModule
