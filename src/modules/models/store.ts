import fs from 'fs'
import os from 'os'
import path from 'path'

export type ModelRecord = {
  model_key: string
  provider: string
  model_id: string
  display_name: string
  alias: string
  base_url: string
  api_type: 'openai-completions' | 'openai-responses'
  auth_mode: 'api_key'
  context_window: number
  max_tokens: number
  supports_text: boolean
  supports_image: boolean
  enabled: boolean
  is_primary: boolean
  api_key?: string
  updated_at: string
}

export type ModelStore = {
  version: number
  default_model: string
  models: Record<string, ModelRecord>
}

export type ModelWritePayload = Partial<Omit<ModelRecord, 'updated_at'>> & {
  model_key: string
}

export const ZDCODE_MODELS_HOME = path.join(os.homedir(), '.zdcode', 'models')
export const ZDCODE_MODELS_CONFIG = path.join(ZDCODE_MODELS_HOME, 'models.json')
export const ZDCODE_MODELS_PORT = Number(process.env.ZDCODE_MODELS_PORT || 4151)
export const ZDCODE_MODELS_HOST = process.env.ZDCODE_MODELS_HOST || '127.0.0.1'

export const modelsBaseUrl = (host = ZDCODE_MODELS_HOST, port = ZDCODE_MODELS_PORT) => `http://${host}:${port}`

const now = () => new Date().toISOString()

const ensureStore = () => {
  fs.mkdirSync(ZDCODE_MODELS_HOME, { recursive: true })
  if (!fs.existsSync(ZDCODE_MODELS_CONFIG)) {
    writeStore({
      version: 1,
      default_model: '',
      models: {},
    })
  }
}

export const readStore = (): ModelStore => {
  ensureStore()
  const parsed = JSON.parse(fs.readFileSync(ZDCODE_MODELS_CONFIG, 'utf-8')) as Partial<ModelStore>
  return {
    version: parsed.version || 1,
    default_model: parsed.default_model || '',
    models: parsed.models || {},
  }
}

export const writeStore = (store: ModelStore) => {
  fs.mkdirSync(ZDCODE_MODELS_HOME, { recursive: true })
  fs.writeFileSync(ZDCODE_MODELS_CONFIG, JSON.stringify(store, null, 2), 'utf-8')
}

export const listModels = () => {
  const store = readStore()
  return Object.values(store.models)
    .sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.model_key.localeCompare(b.model_key))
    .map((model) => ({
      ...redactModel(model),
      is_default: model.model_key === store.default_model,
      api_key_present: Boolean(model.api_key || (model.provider === 'openai' && process.env.OPENAI_API_KEY)),
    }))
}

export const getModel = (modelKey: string) => {
  const store = readStore()
  const model = store.models[modelKey]
  if (!model) {
    throw new Error(`Model not found: ${modelKey}`)
  }
  return model
}

export const getDefaultModelKey = () => readStore().default_model

const normalizeModel = (payload: ModelWritePayload, existing?: ModelRecord): ModelRecord => {
  const modelKey = payload.model_key || existing?.model_key || ''
  if (!modelKey || !modelKey.includes('/')) {
    throw new Error('model_key must use "provider/model" format.')
  }
  const [providerPrefix, modelSuffix] = modelKey.split('/', 2)
  const provider = payload.provider || existing?.provider || providerPrefix
  const modelId = payload.model_id || existing?.model_id || modelSuffix
  return {
    model_key: modelKey,
    provider,
    model_id: modelId,
    display_name: payload.display_name ?? existing?.display_name ?? modelId,
    alias: payload.alias ?? existing?.alias ?? '',
    base_url: payload.base_url ?? existing?.base_url ?? (provider === 'openai' ? 'https://api.openai.com/v1' : ''),
    api_type: payload.api_type ?? existing?.api_type ?? 'openai-completions',
    auth_mode: payload.auth_mode ?? existing?.auth_mode ?? 'api_key',
    context_window: Number(payload.context_window ?? existing?.context_window ?? 0),
    max_tokens: Number(payload.max_tokens ?? existing?.max_tokens ?? 0),
    supports_text: payload.supports_text ?? existing?.supports_text ?? true,
    supports_image: payload.supports_image ?? existing?.supports_image ?? false,
    enabled: payload.enabled ?? existing?.enabled ?? true,
    is_primary: payload.is_primary ?? existing?.is_primary ?? false,
    api_key: payload.api_key && payload.api_key !== '***' ? payload.api_key : existing?.api_key,
    updated_at: now(),
  }
}

export const createModel = (payload: ModelWritePayload) => {
  const store = readStore()
  if (store.models[payload.model_key]) {
    throw new Error(`Model already exists: ${payload.model_key}`)
  }
  const model = normalizeModel(payload)
  store.models[model.model_key] = model
  if (!store.default_model || model.is_primary) {
    store.default_model = model.model_key
  }
  writeStore(store)
  return redactModel(model)
}

export const updateModel = (modelKey: string, payload: Partial<ModelWritePayload>) => {
  const store = readStore()
  const existing = store.models[modelKey]
  if (!existing) {
    throw new Error(`Model not found: ${modelKey}`)
  }
  const model = normalizeModel({ ...payload, model_key: modelKey }, existing)
  store.models[modelKey] = model
  writeStore(store)
  return redactModel(model)
}

export const setDefaultModel = (modelKey: string) => {
  const store = readStore()
  if (!store.models[modelKey]) {
    throw new Error(`Model not found: ${modelKey}`)
  }
  store.default_model = modelKey
  writeStore(store)
  return {
    ok: true,
    default_model: modelKey,
  }
}

export const redactModel = (model: ModelRecord) => {
  const { api_key: apiKey, ...rest } = model
  return {
    ...rest,
    api_key_present: Boolean(apiKey || (model.provider === 'openai' && process.env.OPENAI_API_KEY)),
  }
}
