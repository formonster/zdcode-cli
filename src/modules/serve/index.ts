import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Command } from 'commander'
import Koa from 'koa'
import { getZdcodeHome } from '../../utils/platform'
import { generateImage } from '../image'
import { generateAgensImage } from '../agens/image'
import { generateVideo } from '../agens/video'
import { cloneAudio, designAudio } from '../tts'
import { inspectClone, inspectDesign } from '../tts/engines'
import { generateAudio } from '../audio'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3900
const MAX_BODY_BYTES = 64 * 1024 * 1024

type ServeOptions = {
  host?: string
  port?: string
  cors?: string
  dir?: string
}

const filesDir = (custom?: string) => path.resolve(custom || path.join(getZdcodeHome(), 'serve', 'files'))

const uniqueName = (extension: string) =>
  `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${extension}`

const readJsonBody = async (request: Koa.Request) => {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request.req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('请求体过大（上限 64MB）')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

const requiredString = (body: any, key: string) => {
  const value = body?.[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`缺少必填字段：${key}`)
  }
  return value
}

const optionalString = (value: unknown) => {
  if (value === undefined || value === null || value === '') return undefined
  if (Array.isArray(value)) return value.map((item) => String(item))
  return String(value)
}

const stringList = (value: unknown) => {
  if (!value) return undefined
  if (Array.isArray(value)) return value.map((item) => String(item))
  return [String(value)]
}

/** 同一时间只跑一个本地重任务（TTS 单进程约 6GB 内存） */
let heavyQueue: Promise<unknown> = Promise.resolve()
const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
  const next = heavyQueue.then(task, task)
  heavyQueue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

const contentType = (filePath: string) => {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.wav') return 'audio/wav'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.json') return 'application/json'
  return 'application/octet-stream'
}

const fileUrl = (origin: string, filePath: string) =>
  `${origin}/files/${encodeURIComponent(path.basename(filePath))}`

// Koa 3 的 ctx.origin 返回 null，这里按请求头自行拼装
const originOf = (ctx: Koa.Context) => `${ctx.protocol}://${ctx.host}`

const mediaResult = (origin: string, result: { filePath?: string; url?: string }) => ({
  file: result.filePath ? fileUrl(origin, result.filePath) : undefined,
  path: result.filePath,
  providerUrl: result.url,
})

const allowedOrigins = (value?: string) => {
  const raw = (value || process.env.ZDCODE_SERVE_CORS || '*').trim()
  if (raw === '*') return '*'
  return raw.split(',').map((item) => item.trim()).filter(Boolean)
}

const applyCors = (ctx: Koa.Context, allowed: string[] | '*') => {
  const origin = ctx.get('Origin')
  if (allowed === '*') {
    ctx.set('Access-Control-Allow-Origin', '*')
  } else if (origin && allowed.includes(origin)) {
    ctx.set('Access-Control-Allow-Origin', origin)
    ctx.set('Vary', 'Origin')
  }
  ctx.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  ctx.set('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  ctx.set('Access-Control-Max-Age', '86400')
}

const ENDPOINTS = {
  'GET /health': '服务健康检查',
  'POST /v1/image': '文生图 / 图生图（zdcode image）',
  'POST /v1/agens/image': 'Agnes Image 2.5 Flash（zdcode agens image）',
  'POST /v1/agens/video': 'Agnes Video 2.5（zdcode agens video，同步等待任务完成）',
  'POST /v1/tts/design': '角色音设计（zdcode tts design）',
  'POST /v1/tts/clone': '音色克隆（zdcode tts clone）',
  'GET /v1/tts/doctor': 'TTS 引擎环境检查（zdcode tts doctor）',
  'POST /v1/audio': '音效 / 环境声 / 背景音乐（zdcode audio）',
  'GET /files/<name>': '下载已生成的图片 / 音频 / 视频',
}

export const createServeApp = (options: { cors?: string; dir?: string } = {}) => {
  const app = new Koa()
  const cors = allowedOrigins(options.cors)
  const outDir = filesDir(options.dir)

  app.use(async (ctx) => {
    applyCors(ctx, cors)
    if (ctx.method === 'OPTIONS') {
      ctx.status = 204
      return
    }

    try {
      if (ctx.method === 'GET' && (ctx.path === '/' || ctx.path === '/health')) {
        ctx.body = { ok: true, service: 'zdcode-serve', files: outDir, endpoints: ENDPOINTS }
        return
      }

      if (ctx.method === 'GET' && ctx.path === '/v1/tts/doctor') {
        ctx.body = { ok: true, engines: [inspectDesign(), inspectClone()] }
        return
      }

      if (ctx.method === 'GET' && ctx.path.startsWith('/files/')) {
        const name = decodeURIComponent(ctx.path.slice('/files/'.length))
        if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('非法文件名')
        const target = path.join(outDir, name)
        if (!target.startsWith(outDir) || !fs.existsSync(target)) {
          ctx.status = 404
          ctx.body = { ok: false, error: `文件不存在：${name}` }
          return
        }
        ctx.type = contentType(target)
        ctx.body = fs.createReadStream(target)
        return
      }

      if (ctx.method === 'POST' && ctx.path === '/v1/image') {
        const body = await readJsonBody(ctx.request)
        const prompt = requiredString(body, 'prompt')
        const filePath = path.join(outDir, uniqueName('.png'))
        fs.mkdirSync(outDir, { recursive: true })
        const result = await generateImage(prompt, {
          size: optionalString(body.size) as string | undefined,
          format: (body.format === 'url' ? 'url' : 'b64_json'),
          image: stringList(body.image),
          model: optionalString(body.model) as string | undefined,
          apiUrl: optionalString(body.apiUrl) as string | undefined,
          out: filePath,
        })
        ctx.body = { ok: true, ...mediaResult(originOf(ctx), result) }
        return
      }

      if (ctx.method === 'POST' && ctx.path === '/v1/agens/image') {
        const body = await readJsonBody(ctx.request)
        const prompt = requiredString(body, 'prompt')
        const filePath = path.join(outDir, uniqueName('.png'))
        fs.mkdirSync(outDir, { recursive: true })
        const result = await generateAgensImage(prompt, {
          size: optionalString(body.size) as string | undefined,
          ratio: optionalString(body.ratio) as string | undefined,
          format: body.format === 'b64_json' ? 'b64_json' : 'url',
          image: stringList(body.image),
          model: optionalString(body.model) as string | undefined,
          apiUrl: optionalString(body.apiUrl) as string | undefined,
          out: filePath,
        })
        ctx.body = { ok: true, ...mediaResult(originOf(ctx), result) }
        return
      }

      if (ctx.method === 'POST' && ctx.path === '/v1/agens/video') {
        const body = await readJsonBody(ctx.request)
        const filePath = path.join(outDir, uniqueName('.mp4'))
        fs.mkdirSync(outDir, { recursive: true })
        const result = await generateVideo(optionalString(body.prompt), {
          mode: optionalString(body.mode),
          seconds: optionalString(body.seconds),
          size: optionalString(body.size),
          aspectRatio: optionalString(body.aspectRatio),
          seed: optionalString(body.seed),
          firstFrame: optionalString(body.firstFrame),
          lastFrame: optionalString(body.lastFrame),
          image: stringList(body.image),
          audio: stringList(body.audio),
          video: stringList(body.video),
          taskId: optionalString(body.taskId),
          pollInterval: optionalString(body.pollInterval),
          timeout: optionalString(body.timeout),
          model: optionalString(body.model),
          apiUrl: optionalString(body.apiUrl),
          out: filePath,
        })
        ctx.body = { ok: true, videoId: result.videoId, ...mediaResult(originOf(ctx), result) }
        return
      }

      if (ctx.method === 'POST' && ctx.path === '/v1/tts/design') {
        const body = await readJsonBody(ctx.request)
        const text = requiredString(body, 'text')
        const voice = requiredString(body, 'voice')
        const filePath = path.join(outDir, uniqueName('.wav'))
        fs.mkdirSync(outDir, { recursive: true })
        const out = await enqueue(() => designAudio({
          text,
          voice,
          out: filePath,
          language: optionalString(body.language),
          device: optionalString(body.device),
        }))
        ctx.body = { ok: true, file: fileUrl(originOf(ctx), out), path: out }
        return
      }

      if (ctx.method === 'POST' && ctx.path === '/v1/audio') {
        const body = await readJsonBody(ctx.request)
        const prompt = requiredString(body, 'prompt')
        const filePath = path.join(outDir, uniqueName('.wav'))
        fs.mkdirSync(outDir, { recursive: true })
        const result = await enqueue(() => generateAudio({
          prompt,
          out: filePath,
          model: optionalString(body.model) as string | undefined,
          seconds: optionalString(body.seconds) as string | undefined,
          steps: optionalString(body.steps) as string | undefined,
          cfg: optionalString(body.cfg) as string | undefined,
          seed: optionalString(body.seed) as string | undefined,
          device: optionalString(body.device) as string | undefined,
        }))
        ctx.body = {
          ok: true,
          file: fileUrl(originOf(ctx), result.filePath),
          path: result.filePath,
          model: result.model,
          seconds: result.seconds,
          steps: result.steps,
          cfg: result.cfg,
          seed: result.seed,
        }
        return
      }

      if (ctx.method === 'POST' && ctx.path === '/v1/tts/clone') {
        const body = await readJsonBody(ctx.request)
        const text = requiredString(body, 'text')
        const filePath = path.join(outDir, uniqueName('.wav'))
        fs.mkdirSync(outDir, { recursive: true })
        const out = await enqueue(() => cloneAudio({
          text,
          out: filePath,
          instruct: optionalString(body.instruct),
          speed: optionalString(body.speed),
          nfe: optionalString(body.nfe),
          device: optionalString(body.device),
          refWav: optionalString(body.refWav),
          refText: optionalString(body.refText),
          sentencePauseMs: optionalString(body.sentencePauseMs),
          paragraphPauseMs: optionalString(body.paragraphPauseMs),
        }))
        ctx.body = { ok: true, file: fileUrl(originOf(ctx), out), path: out }
        return
      }

      ctx.status = 404
      ctx.body = { ok: false, error: `未知路由：${ctx.method} ${ctx.path}` }
    } catch (error) {
      ctx.status = 400
      ctx.body = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  return app
}

export const serveCli = (options: ServeOptions) => {
  const host = options.host || process.env.ZDCODE_SERVE_HOST || DEFAULT_HOST
  const port = Number(options.port || process.env.ZDCODE_SERVE_PORT || DEFAULT_PORT)
  const app = createServeApp({ cors: options.cors, dir: options.dir })
  const server = app.listen(port, host, () => {
    const base = `http://${host}:${port}`
    console.log('✅ zdcode 接口服务已启动')
    console.log(`- 地址：${base}`)
    console.log(`- 文件目录：${filesDir(options.dir)}`)
    console.log(`- CORS：${options.cors || process.env.ZDCODE_SERVE_CORS || '*'}`)
    console.log('- 已暴露：image / agens image / agens video / tts design / tts clone / audio')
  })
  // 生成类请求耗时较长，关闭 Node 默认的请求超时
  server.requestTimeout = 0
  server.headersTimeout = 0
  return server
}

const registerServeModule = (program: Command) => {
  program
    .command('serve')
    .description('以 HTTP 接口方式暴露 image / agens / tts / audio 能力（默认 127.0.0.1:3900）')
    .option('--host <host>', '监听地址', DEFAULT_HOST)
    .option('--port <port>', '监听端口', String(DEFAULT_PORT))
    .option('--cors <origins>', '允许的来源，* 或逗号分隔的白名单', '*')
    .option('--dir <path>', '生成文件的输出目录')
    .action((options: ServeOptions) => {
      serveCli(options)
    })
}

export default registerServeModule
