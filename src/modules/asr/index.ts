import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { Command } from 'commander'
import { getPackageRoot, getZdcodeVenvPython } from '../../utils/platform'

export type TranscribeOptions = {
  audio: string
  out?: string
  baseUrl?: string
  model?: string
  language?: string
  task?: string
  startTime?: string
  responseFormat?: string
  json?: boolean
}

type ServeOptions = {
  python?: string
  host?: string
  port?: string
}

type RawAsrSegment = {
  start?: number
  end?: number
  text?: string
}

const DEFAULT_FUNASR_BASE_URL = 'http://127.0.0.1:8766'
const DEFAULT_FUNASR_MODEL = 'paraformer-zh'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const findRuntimeServer = () => {
  const candidates = [
    path.resolve(getPackageRoot(), 'src', 'modules', 'asr', 'runtime', 'funasr_server.py'),
    path.resolve(__dirname, 'runtime', 'funasr_server.py'),
    path.resolve(__dirname, '..', 'src', 'modules', 'asr', 'runtime', 'funasr_server.py'),
    path.resolve(process.cwd(), 'src', 'modules', 'asr', 'runtime', 'funasr_server.py'),
  ]
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (!found) {
    throw new Error(`Unable to find ASR runtime server. Checked: ${candidates.join(', ')}`)
  }
  return found
}

const normalizeBaseUrl = (value?: string) => (value || DEFAULT_FUNASR_BASE_URL).replace(/\/+$/, '').replace(/\/v1$/, '')

const formatClock = (seconds: number) => {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(safeSeconds / 3600)
  const m = Math.floor((safeSeconds % 3600) / 60)
  const s = safeSeconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

const requireFile = (filePath: string) => {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) {
    throw new Error(`Audio file not found: ${resolved}`)
  }
  return resolved
}

const toNumber = (value: string | undefined, fallback = 0) => {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number: ${value}`)
  }
  return parsed
}

const normalizeSegments = (segments: RawAsrSegment[] | undefined, startOffsetSeconds: number) => {
  return (segments || []).map((segment) => {
    const relativeStartSeconds = Number(segment.start || 0)
    const relativeEndSeconds = Number(segment.end || relativeStartSeconds)
    const startSeconds = startOffsetSeconds + relativeStartSeconds
    const endSeconds = startOffsetSeconds + relativeEndSeconds
    return {
      start: formatClock(startSeconds),
      end: formatClock(endSeconds),
      startSeconds,
      endSeconds,
      relativeStartSeconds,
      relativeEndSeconds,
      text: String(segment.text || '').trim(),
    }
  }).filter((segment) => segment.text)
}

export const transcribeAudio = async (options: TranscribeOptions) => {
  const audioPath = requireFile(options.audio)
  const buffer = fs.readFileSync(audioPath)
  const form = new FormData()
  form.append('file', new Blob([buffer]), path.basename(audioPath))
  form.append('model', options.model || DEFAULT_FUNASR_MODEL)
  form.append('language', options.language || 'zh')
  form.append('task', options.task || 'transcribe')
  form.append('response_format', options.responseFormat || 'json')

  const endpoint = `${normalizeBaseUrl(options.baseUrl)}/v1/audio/transcriptions`
  const response = await fetch(endpoint, {
    method: 'POST',
    body: form,
  })
  const contentType = response.headers.get('content-type') || ''
  const raw = contentType.includes('application/json') ? await response.json() : await response.text()
  if (!response.ok) {
    const message = typeof raw === 'string' ? raw : raw?.detail || raw?.error?.message || JSON.stringify(raw)
    throw new Error(message)
  }

  const startOffsetSeconds = toNumber(options.startTime)
  return {
    audio: audioPath,
    provider: 'funasr',
    endpoint,
    model: options.model || DEFAULT_FUNASR_MODEL,
    startOffsetSeconds,
    durationSeconds: typeof raw === 'object' ? raw.duration : undefined,
    text: typeof raw === 'object' ? raw.text || '' : String(raw || ''),
    segments: typeof raw === 'object' ? normalizeSegments(raw.segments, startOffsetSeconds) : [],
    raw,
  }
}

const runTranscribeCommand = async (options: TranscribeOptions) => {
  const payload = await transcribeAudio(options)
  if (options.out) {
    fs.writeFileSync(path.resolve(options.out), JSON.stringify(payload, null, 2), 'utf-8')
  }
  if (options.json || !options.out) {
    console.log(JSON.stringify(payload, null, 2))
  } else {
    console.log(`✅ Transcript written: ${path.resolve(options.out)}`)
  }
}

const registerAsrModule = (program: Command) => {
  const asr = program.command('asr').description('语音转写工具')

  asr
    .command('serve')
    .description('启动内置 FunASR 转写服务')
    .option('--python <path>', 'Python 解释器路径', process.env.ZDCODE_ASR_PYTHON || getZdcodeVenvPython('asr'))
    .option('--host <host>', '监听地址', '127.0.0.1')
    .option('--port <port>', '监听端口', '8766')
    .action((options: ServeOptions) => {
      const serverPath = findRuntimeServer()
      const result = spawnSync(options.python || getZdcodeVenvPython('asr'), [serverPath], {
        cwd: path.dirname(serverPath),
        stdio: 'inherit',
        env: {
          ...process.env,
          FUNASR_HOST: options.host || '127.0.0.1',
          FUNASR_PORT: options.port || '8766',
        },
      })
      process.exit(result.status ?? 0)
    })

  asr
    .command('transcribe')
    .description('输入音频文件，输出带时间轴的转写分段')
    .requiredOption('--audio <path>', '音频文件路径')
    .option('--out <path>', '输出 JSON 文件路径')
    .option('--base-url <url>', 'ASR 服务 Base URL', DEFAULT_FUNASR_BASE_URL)
    .option('--model <model>', 'ASR 模型', DEFAULT_FUNASR_MODEL)
    .option('--language <language>', '语言', 'zh')
    .option('--task <task>', '任务类型', 'transcribe')
    .option('--start-time <seconds>', '音频开头对应的视频原始时间，单位秒', '0')
    .option('--response-format <format>', 'ASR 响应格式', 'json')
    .option('--json', '即使写入文件也打印 JSON', false)
    .action(async (options: TranscribeOptions) => {
      await runTranscribeCommand(options)
    })
}

export default registerAsrModule
