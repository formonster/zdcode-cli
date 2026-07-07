import Koa from 'koa'
import {
  createModel,
  getDefaultModelKey,
  getModel,
  listModels,
  modelsBaseUrl,
  redactModel,
  setDefaultModel,
  updateModel,
  ZDCODE_MODELS_HOST,
  ZDCODE_MODELS_PORT,
} from './store'
import { invokeModel } from './invoke'

const readJsonBody = async (request: Koa.Request) => {
  const chunks: Buffer[] = []
  for await (const chunk of request.req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim()
  return raw ? JSON.parse(raw) : {}
}

const modelKeyFromPath = (path: string) => decodeURIComponent(path.replace(/^\/models\/?/, ''))

export const createModelsApp = () => {
  const app = new Koa()

  app.use(async (ctx) => {
    try {
      if (ctx.method === 'GET' && ctx.path === '/health') {
        ctx.body = {
          ok: true,
          service: 'zdcode-models',
          default_model: getDefaultModelKey(),
        }
        return
      }

      if (ctx.method === 'GET' && ctx.path === '/models') {
        ctx.body = listModels()
        return
      }

      if (ctx.method === 'POST' && ctx.path === '/models') {
        ctx.body = createModel(await readJsonBody(ctx.request))
        return
      }

      if (ctx.method === 'POST' && ctx.path === '/models/default') {
        const body = await readJsonBody(ctx.request)
        ctx.body = setDefaultModel(String(body.model_key || ''))
        return
      }

      if (ctx.method === 'POST' && ctx.path === '/invoke') {
        ctx.body = await invokeModel(await readJsonBody(ctx.request))
        return
      }

      if (ctx.path.startsWith('/models/')) {
        const modelKey = modelKeyFromPath(ctx.path)
        if (ctx.method === 'GET') {
          ctx.body = redactModel(getModel(modelKey))
          return
        }
        if (ctx.method === 'PATCH') {
          ctx.body = updateModel(modelKey, await readJsonBody(ctx.request))
          return
        }
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

export const serveModels = (options: { host?: string; port?: number }) => {
  const host = options.host || ZDCODE_MODELS_HOST
  const port = options.port || ZDCODE_MODELS_PORT
  const app = createModelsApp()
  app.listen(port, host, () => {
    console.log('✅ ZDCode model service ready')
    console.log(`- url: ${modelsBaseUrl(host, port)}`)
    console.log(`- health: ${modelsBaseUrl(host, port)}/health`)
  })
}
