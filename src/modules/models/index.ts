import fs from 'fs'
import { Command } from 'commander'
import {
  createModel,
  listModels,
  modelsBaseUrl,
  redactModel,
  getModel,
  setDefaultModel,
  updateModel,
  ZDCODE_MODELS_HOST,
  ZDCODE_MODELS_PORT,
} from './store'
import { serveModels } from './server'

type ModelCreateOptions = {
  modelKey: string
  provider?: string
  modelId?: string
  displayName?: string
  alias?: string
  baseUrl?: string
  apiType?: 'openai-completions' | 'openai-responses'
  contextWindow?: string
  maxTokens?: string
  apiKey?: string
  supportsImage?: boolean
  disabled?: boolean
  primary?: boolean
}

type ModelUpdateOptions = Partial<ModelCreateOptions>

type ModelCallOptions = {
  serviceUrl?: string
  model?: string
  input?: string
  inputFile?: string
  system?: string
  systemFile?: string
  temperature?: string
  maxTokens?: string
  jsonSchema?: string
  out?: string
  raw?: boolean
}

const printJson = (payload: unknown) => {
  console.log(JSON.stringify(payload, null, 2))
}

const readOptionalText = (value?: string, file?: string) => {
  if (typeof value === 'string' && value.trim()) return value
  if (file?.trim()) return fs.readFileSync(file.trim(), 'utf-8')
  return ''
}

const optionalNumber = (value?: string) => {
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number: ${value}`)
  return parsed
}

const modelWritePayload = (options: ModelCreateOptions | ModelUpdateOptions) => {
  const keyParts = options.modelKey?.split('/', 2)
  return {
    model_key: options.modelKey || '',
    provider: options.provider || keyParts?.[0],
    model_id: options.modelId || keyParts?.[1],
    display_name: options.displayName,
    alias: options.alias,
    base_url: options.baseUrl,
    api_type: options.apiType,
    context_window: optionalNumber(options.contextWindow),
    max_tokens: optionalNumber(options.maxTokens),
    api_key: options.apiKey,
    supports_image: options.supportsImage,
    enabled: options.disabled === undefined ? undefined : !options.disabled,
    is_primary: options.primary,
  }
}

const postJson = async <T>(url: string, body: unknown) => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    const payload = text ? JSON.parse(text) : {}
    if (!response.ok) {
      throw new Error(payload?.error || payload?.detail || response.statusText)
    }
    return payload as T
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Model service unreachable: ${url}. Start it with "zdcode model serve".`)
    }
    throw error
  }
}

const registerModelModule = (program: Command) => {
  const model = program.command('model').description('独立模型注册表与 Koa 调用服务')

  model
    .command('serve')
    .description('启动轻量 Koa 模型调用服务')
    .option('--host <host>', '监听地址', ZDCODE_MODELS_HOST)
    .option('--port <port>', '监听端口', String(ZDCODE_MODELS_PORT))
    .action((options: { host?: string; port?: string }) => {
      serveModels({
        host: options.host || ZDCODE_MODELS_HOST,
        port: Number(options.port || ZDCODE_MODELS_PORT),
      })
    })

  model
    .command('ls')
    .description('列出已配置模型')
    .action(() => {
      listModels().forEach((item, index) => {
        console.log(`${index + 1}. ${item.model_key}${item.is_default ? ' [default]' : ''}`)
        console.log(`   provider: ${item.provider}`)
        console.log(`   name: ${item.alias || item.display_name}`)
        console.log(`   api_key: ${item.api_key_present ? 'present' : 'missing'}`)
      })
    })

  model
    .command('inspect <modelKey>')
    .description('查看模型详情')
    .action((modelKey: string) => {
      printJson(redactModel(getModel(modelKey)))
    })

  model
    .command('create')
    .description('创建一个模型配置')
    .requiredOption('--model-key <key>', '模型 key，格式 provider/model-id')
    .option('--provider <provider>', 'provider 名称，默认取 model-key 前缀')
    .option('--model-id <id>', '真实模型 id，默认取 model-key 后缀')
    .option('--display-name <name>', '展示名')
    .option('--alias <alias>', '别名')
    .option('--base-url <url>', 'OpenAI-compatible base URL')
    .option('--api-type <type>', 'openai-completions | openai-responses', 'openai-completions')
    .option('--context-window <number>', '上下文窗口')
    .option('--max-tokens <number>', '最大输出 token')
    .option('--api-key <key>', 'API Key')
    .option('--supports-image', '支持图片输入', false)
    .option('--disabled', '创建后禁用', false)
    .option('--primary', '标记为 primary', false)
    .action((options: ModelCreateOptions) => {
      printJson(createModel(modelWritePayload(options)))
    })

  model
    .command('update <modelKey>')
    .description('更新模型配置')
    .option('--provider <provider>', 'provider 名称')
    .option('--model-id <id>', '真实模型 id')
    .option('--display-name <name>', '展示名')
    .option('--alias <alias>', '别名')
    .option('--base-url <url>', 'OpenAI-compatible base URL')
    .option('--api-type <type>', 'openai-completions | openai-responses')
    .option('--context-window <number>', '上下文窗口')
    .option('--max-tokens <number>', '最大输出 token')
    .option('--api-key <key>', 'API Key')
    .option('--supports-image', '支持图片输入')
    .option('--disabled', '禁用模型')
    .option('--primary', '标记为 primary')
    .action((modelKey: string, options: ModelUpdateOptions) => {
      printJson(updateModel(modelKey, modelWritePayload({ ...options, modelKey })))
    })

  model
    .command('set-default <modelKey>')
    .alias('default')
    .description('设置默认模型')
    .action((modelKey: string) => {
      printJson(setDefaultModel(modelKey))
    })

  model
    .command('call')
    .description('通过 Koa 模型服务调用一个已注册模型，不混入任何业务逻辑')
    .option('--service-url <url>', '模型服务 URL', modelsBaseUrl())
    .option('--model <modelKey>', '模型 key；不传则使用默认模型')
    .option('--input <text>', '用户输入文本')
    .option('--input-file <path>', '从文件读取用户输入')
    .option('--system <text>', '系统提示词')
    .option('--system-file <path>', '从文件读取系统提示词')
    .option('--temperature <number>', '采样温度')
    .option('--max-tokens <number>', '最大输出 token')
    .option('--json-schema <path>', 'JSON Schema 文件，用于结构化输出')
    .option('--out <path>', '将返回结果写入文件')
    .option('--raw', '只打印模型文本', false)
    .action(async (options: ModelCallOptions) => {
      try {
        const input = readOptionalText(options.input, options.inputFile)
        if (!input) throw new Error('model call requires --input or --input-file.')
        const schema = options.jsonSchema ? JSON.parse(fs.readFileSync(options.jsonSchema, 'utf-8')) : undefined
        const payload = await postJson(`${(options.serviceUrl || modelsBaseUrl()).replace(/\/+$/, '')}/invoke`, {
          model_key: options.model,
          input,
          system: readOptionalText(options.system, options.systemFile),
          temperature: optionalNumber(options.temperature),
          max_tokens: optionalNumber(options.maxTokens),
          response_format: schema ? { type: 'json_schema', schema } : undefined,
        })
        if (options.out) fs.writeFileSync(options.out, JSON.stringify(payload, null, 2), 'utf-8')
        if (options.raw) {
          console.log((payload as any).text || '')
        } else {
          printJson(payload)
        }
      } catch (error) {
        console.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })
}

export default registerModelModule
