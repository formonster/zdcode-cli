import { getDefaultModelKey, getModel, ModelRecord } from './store'

export type ModelInvokePayload = {
  model_key?: string
  input: string
  system?: string
  temperature?: number
  max_tokens?: number
  response_format?: {
    type: string
    name?: string
    schema?: unknown
  }
}

const normalizeBaseUrl = (baseUrl: string) => {
  const cleaned = (baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '')
  try {
    const parsed = new URL(cleaned)
    if (parsed.hostname === 'api.openai.com' && (parsed.pathname === '' || parsed.pathname === '/')) {
      return `${cleaned}/v1`
    }
  } catch {
    // Let fetch surface the invalid URL in the final request path.
  }
  return cleaned
}

const apiKeyForModel = (model: ModelRecord) => {
  if (model.api_key) return model.api_key
  if (model.provider === 'openai') return process.env.OPENAI_API_KEY || ''
  return ''
}

const normalizeResponseFormat = (format: ModelInvokePayload['response_format'], apiType: ModelRecord['api_type']) => {
  if (!format) return undefined
  if (format.type !== 'json_schema') return format
  const name = format.name || 'model_call_result'
  if (apiType === 'openai-responses') {
    return {
      type: 'json_schema',
      name,
      schema: format.schema,
    }
  }
  return {
    type: 'json_schema',
    json_schema: {
      name,
      schema: format.schema,
    },
  }
}

const readJsonResponse = async (response: Response) => {
  const text = await response.text()
  const payload = text ? JSON.parse(text) : {}
  if (!response.ok) {
    throw new Error(payload?.error?.message || payload?.detail || text || response.statusText)
  }
  return payload
}

const postModelJson = async (url: string, headers: Record<string, string>, body: Record<string, unknown>) => {
  try {
    return await readJsonResponse(await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }))
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Model endpoint unreachable: ${url}. ${error.message}`)
    }
    throw error
  }
}

const extractText = (apiType: ModelRecord['api_type'], data: any) => {
  if (apiType === 'openai-responses') {
    if (typeof data?.output_text === 'string') return data.output_text
    const parts = (data?.output || []).flatMap((item: any) => item.content || [])
    return parts.map((part: any) => part.text || '').join('\n').trim()
  }
  const content = data?.choices?.[0]?.message?.content
  return typeof content === 'string' ? content : content ? JSON.stringify(content) : ''
}

export const invokeModel = async (payload: ModelInvokePayload) => {
  const modelKey = payload.model_key || getDefaultModelKey()
  if (!modelKey) {
    throw new Error('No model specified and no default model configured.')
  }
  const model = getModel(modelKey)
  if (!model.enabled) {
    throw new Error(`Model is disabled: ${modelKey}`)
  }
  if (!model.supports_text) {
    throw new Error(`Model does not support text input: ${modelKey}`)
  }
  const apiKey = apiKeyForModel(model)
  if (!apiKey) {
    throw new Error(`API key is missing for model provider: ${model.provider}`)
  }

  const baseUrl = normalizeBaseUrl(model.base_url)
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  }

  if (model.api_type === 'openai-responses') {
    const textFormat = normalizeResponseFormat(payload.response_format, model.api_type)
    const body: Record<string, unknown> = {
      model: model.model_id,
      input: [
        ...(payload.system ? [{ role: 'system', content: payload.system }] : []),
        { role: 'user', content: payload.input },
      ],
    }
    if (textFormat) body.text = { format: textFormat }
    if (payload.temperature !== undefined) body.temperature = payload.temperature
    if (payload.max_tokens !== undefined) body.max_output_tokens = payload.max_tokens

    const raw = await postModelJson(`${baseUrl}/responses`, headers, body)
    return {
      model_key: modelKey,
      model_id: model.model_id,
      provider: model.provider,
      api_type: model.api_type,
      text: extractText(model.api_type, raw),
      raw,
    }
  }

  const responseFormat = normalizeResponseFormat(payload.response_format, model.api_type)
  const body: Record<string, unknown> = {
    model: model.model_id,
    messages: [
      ...(payload.system ? [{ role: 'system', content: payload.system }] : []),
      { role: 'user', content: payload.input },
    ],
  }
  if (responseFormat) body.response_format = responseFormat
  if (payload.temperature !== undefined) body.temperature = payload.temperature
  if (payload.max_tokens !== undefined) body.max_tokens = payload.max_tokens

  const raw = await postModelJson(`${baseUrl}/chat/completions`, headers, body)
  return {
    model_key: modelKey,
    model_id: model.model_id,
    provider: model.provider,
    api_type: model.api_type,
    text: extractText(model.api_type, raw),
    raw,
  }
}
