import path from 'node:path'
import { Command } from 'commander'
import { agensVideoConfig, agnesApiOrigin, missingApiKeyError, videosEndpoint } from './api'
import {
  DEFAULT_API_URL,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_VIDEO_ASPECT_RATIO,
  DEFAULT_VIDEO_MODEL,
  DEFAULT_VIDEO_SECONDS,
  DEFAULT_VIDEO_SIZE,
  VIDEO_ASPECT_RATIOS,
  VIDEO_MODES,
  VIDEO_SIZES,
} from './constants'
import type { AgensVideoOptions, VideoTask, VideoTaskResponse } from './types'
import {
  collect,
  downloadFile,
  errorDetails,
  positiveInteger,
  readJsonResponse,
  sleep,
} from './utils'

const validateVideoOptions = (options: AgensVideoOptions) => {
  const mode = options.mode || 'text'
  if (!VIDEO_MODES.includes(mode)) {
    throw new Error(`mode must be one of: ${VIDEO_MODES.join(', ')}`)
  }
  if (options.size && !VIDEO_SIZES.includes(options.size)) {
    throw new Error(`size must be one of: ${VIDEO_SIZES.join(', ')}`)
  }
  if (options.aspectRatio && !VIDEO_ASPECT_RATIOS.includes(options.aspectRatio)) {
    throw new Error(`aspect-ratio must be one of: ${VIDEO_ASPECT_RATIOS.join(', ')}`)
  }
  if (options.seconds) {
    const seconds = positiveInteger(options.seconds, 'seconds')
    if (seconds < 4 || seconds > 12) throw new Error('seconds must be between 4 and 12')
  }
  if (options.seed !== undefined && !/^-?\d+$/.test(options.seed)) {
    throw new Error('seed must be an integer')
  }

  const images = options.image || []
  const audios = options.audio || []
  const videos = options.video || []
  const mediaCount = images.length + audios.length + videos.length

  if (mode === 'text') {
    if (options.firstFrame || options.lastFrame || mediaCount) {
      throw new Error('mode "text" does not accept first-frame, last-frame, images, audios or videos')
    }
    return
  }

  if (mode === 'keyframe') {
    if (!options.firstFrame && !options.lastFrame) {
      throw new Error('mode "keyframe" requires at least one of --first-frame / --last-frame')
    }
    if (mediaCount) {
      throw new Error('mode "keyframe" does not accept images, audios or videos')
    }
    return
  }

  // reference
  if (mediaCount === 0) {
    throw new Error('mode "reference" requires at least one of --image / --audio / --video')
  }
  if (options.firstFrame || options.lastFrame) {
    throw new Error('mode "reference" does not accept --first-frame or --last-frame')
  }
}

const buildVideoBody = (prompt: string, options: AgensVideoOptions, model: string) => {
  const body: Record<string, unknown> = {
    model,
    prompt,
    mode: options.mode || 'text',
  }
  if (options.seconds) body.seconds = options.seconds
  if (options.size) body.size = options.size
  if (options.aspectRatio) body.aspect_ratio = options.aspectRatio
  if (options.seed !== undefined) body.seed = Number(options.seed)
  if (options.firstFrame) body.first_frame = options.firstFrame
  if (options.lastFrame) body.last_frame = options.lastFrame
  if (options.image?.length) body.images = options.image
  if (options.audio?.length) body.audios = options.audio
  if (options.video?.length) body.videos = options.video.map((url) => ({ url }))
  return body
}

const submitVideoTask = async (apiUrl: string, apiKey: string, body: Record<string, unknown>) => {
  let response: Response
  try {
    response = await fetch(videosEndpoint(apiUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new Error(`Agens video task submission failed before response: ${errorDetails(error)}`)
  }
  return readJsonResponse<VideoTaskResponse>('Agens video task submission failed', response)
}

const queryVideoTask = async (apiUrl: string, apiKey: string, videoId: string, model: string) => {
  const url = new URL(`${agnesApiOrigin(apiUrl)}/agnesapi`)
  url.searchParams.set('video_id', videoId)
  url.searchParams.set('model_name', model)

  let response: Response
  try {
    response = await fetch(url.toString(), {
      headers: { authorization: `Bearer ${apiKey}` },
    })
  } catch (error) {
    throw new Error(`Agens video task query network error: ${errorDetails(error)}`)
  }
  const payload = await readJsonResponse<VideoTaskResponse>('Agens video task query failed', response)
  return payload.data || payload
}

const formatTaskError = (error: VideoTask['error']) => {
  if (!error) return 'Unknown video generation error.'
  if (typeof error === 'string') return error
  const details = [error.code, error.message].filter(Boolean)
  return details.length ? details.join(': ') : JSON.stringify(error)
}

const waitForVideoTask = async (
  apiUrl: string,
  apiKey: string,
  videoId: string,
  model: string,
  options: AgensVideoOptions,
) => {
  const pollInterval = positiveInteger(options.pollInterval || String(DEFAULT_POLL_INTERVAL_SECONDS), 'poll interval')
  const timeout = positiveInteger(options.timeout || String(DEFAULT_TIMEOUT_SECONDS), 'timeout')
  const deadline = Date.now() + timeout * 1000

  while (Date.now() < deadline) {
    const task = await queryVideoTask(apiUrl, apiKey, videoId, model)
    const status = task.status
    if (status === 'completed') {
      const url = task.url || task.metadata?.url
      if (!url) throw new Error(`Agens video task ${videoId} completed without a video URL.`)
      console.log(`video_url=${url}`)
      if (options.out) {
        const filePath = path.resolve(options.out)
        await downloadFile(filePath, url)
        console.log(`✅ Video written: ${filePath}`)
      }
      return
    }
    if (status === 'failed') {
      throw new Error(`Agens video task ${videoId} failed: ${formatTaskError(task.error)}`)
    }
    if (status !== 'queued' && status !== 'in_progress' && status !== 'processing' && status !== 'pending') {
      throw new Error(`Agens video task ${videoId} returned unknown status: ${status || '<empty>'}`)
    }

    const progress = typeof task.progress === 'number' ? ` (${task.progress}%)` : ''
    console.log(`Agens video task ${videoId}: ${status}${progress}`)
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await sleep(Math.min(pollInterval * 1000, remaining))
  }

  throw new Error(
    `Agens video task ${videoId} did not finish within ${timeout} seconds. Resume with: zdcode agens video --task-id ${videoId}`,
  )
}

const generateVideo = async (prompt: string | undefined, options: AgensVideoOptions) => {
  const config = agensVideoConfig(options)
  if (!config.apiKey) throw new Error(missingApiKeyError('AGNES_VIDEO_API_KEY'))

  let videoId = options.taskId
  if (!videoId) {
    if (!prompt?.trim()) throw new Error('prompt is required when --task-id is not provided')
    validateVideoOptions(options)
    const body = buildVideoBody(prompt, options, config.model)
    const task = await submitVideoTask(config.apiUrl, config.apiKey, body)
    videoId = task.video_id || task.task_id || task.id
    if (!videoId) {
      throw new Error(`Agens video task submission succeeded without a video ID: ${JSON.stringify(task)}`)
    }
    console.log(`video_id=${videoId}`)
  }

  await waitForVideoTask(config.apiUrl, config.apiKey, videoId, config.model, options)
}

export const registerAgensVideo = (agens: Command) => {
  agens
    .command('video [prompt]')
    .description('使用 Agnes Video 2.5 生成视频（text / keyframe / reference），或使用 --task-id 继续查询已有任务')
    .option('--mode <mode>', `生成模式，可选：${VIDEO_MODES.join(' ')}`, 'text')
    .option('--seconds <seconds>', '视频时长 4-12 秒，默认 5', DEFAULT_VIDEO_SECONDS)
    .option('--size <size>', `输出分辨率档位，可选：${VIDEO_SIZES.join(' ')}`)
    .option('--aspect-ratio <ratio>', `画幅比例，可选：${VIDEO_ASPECT_RATIOS.join(' ')}`)
    .option('--seed <seed>', '随机种子，相同种子可提高可复现性')
    .option('--first-frame <url>', '首帧图片 URL（keyframe 模式）')
    .option('--last-frame <url>', '尾帧图片 URL（keyframe 模式）')
    .option('--image <url>', '参考图片 URL，可重复（reference 模式）', collect, [])
    .option('--audio <url>', '参考音频 URL，可重复（reference 模式）', collect, [])
    .option('--video <url>', '参考视频 URL，可重复（reference 模式）', collect, [])
    .option('-o, --out <path>', '输出视频路径')
    .option('--task-id <videoId>', '跳过提交，继续查询已有任务')
    .option('--poll-interval <seconds>', '查询间隔秒数', String(DEFAULT_POLL_INTERVAL_SECONDS))
    .option('--timeout <seconds>', '最长等待秒数', String(DEFAULT_TIMEOUT_SECONDS))
    .option('--api-url <url>', 'Agnes API base URL', DEFAULT_API_URL)
    .option('--model <model>', '视频模型', DEFAULT_VIDEO_MODEL)
    .action(async (prompt: string | undefined, options: AgensVideoOptions) => {
      try {
        await generateVideo(prompt, options)
      } catch (error) {
        console.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
      }
    })
}
