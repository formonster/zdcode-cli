import Koa from 'koa'
import { transcribeAudio } from '../asr'
import { modelsBaseUrl } from '../models/store'
import { normalizeTranscript, optionalNumber, summarizeArchive, summarizeVideoTranscript } from './core'

const readJsonBody = async (request: Koa.Request) => {
  const chunks: Buffer[] = []
  for await (const chunk of request.req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim()
  return raw ? JSON.parse(raw) : {}
}

export const createVideoApp = (options: { modelServiceUrl?: string } = {}) => {
  const app = new Koa()

  app.use(async (ctx) => {
    try {
      if (ctx.method === 'GET' && ctx.path === '/health') {
        ctx.body = {
          ok: true,
          service: 'zdcode-video',
          modelServiceUrl: options.modelServiceUrl || modelsBaseUrl(),
        }
        return
      }

      if (ctx.method === 'POST' && ctx.path === '/asr/transcribe') {
        const body = await readJsonBody(ctx.request)
        ctx.body = await transcribeAudio({
          audio: String(body.audio || body.audioPath || ''),
          baseUrl: body.baseUrl,
          model: body.model,
          language: body.language,
          task: body.task,
          startTime: body.startTime === undefined ? String(body.start_time || '') : String(body.startTime),
          responseFormat: body.responseFormat || body.response_format,
        })
        return
      }

      if (ctx.method === 'POST' && ctx.path === '/video/summarize') {
        const body = await readJsonBody(ctx.request)
        const transcript = normalizeTranscript(body.transcript || body.transcriptSegments || body.segments)
        ctx.body = await summarizeVideoTranscript({
          transcript,
          frames: Array.isArray(body.frames) ? body.frames : [],
          title: body.title || body.metadata?.pageTitle || body.metadata?.title || '',
          url: body.url || body.metadata?.pageUrl || body.metadata?.url || '',
          serviceUrl: body.modelServiceUrl || body.model_service_url || options.modelServiceUrl,
          model: body.model,
          maxTokens: optionalNumber(body.maxTokens || body.max_tokens),
        })
        return
      }

      if (ctx.method === 'POST' && ctx.path === '/video/summarize-archive') {
        const body = await readJsonBody(ctx.request)
        ctx.body = await summarizeArchive({
          archive: String(body.archive || body.archivePath || ''),
          serviceUrl: body.modelServiceUrl || body.model_service_url || options.modelServiceUrl,
          model: body.model,
          maxTokens: body.maxTokens || body.max_tokens,
          renameFolder: Boolean(body.renameFolder || body.rename_folder),
        })
        return
      }

      ctx.status = 404
      ctx.body = {
        error: `Unknown route: ${ctx.method} ${ctx.path}`,
      }
    } catch (error) {
      ctx.status = 400
      ctx.body = {
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  return app
}

export const serveVideo = (options: { host?: string; port?: number; modelServiceUrl?: string }) => {
  const host = options.host || '127.0.0.1'
  const port = options.port || 4171
  const app = createVideoApp({
    modelServiceUrl: options.modelServiceUrl,
  })
  app.listen(port, host, () => {
    console.log('✅ ZDCode video service ready')
    console.log(`- url: http://${host}:${port}`)
    console.log(`- health: http://${host}:${port}/health`)
  })
}
