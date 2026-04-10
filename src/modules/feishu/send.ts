import axios, { AxiosError } from 'axios'
import { FeishuReceiveIdType, resolveFeishuTarget } from './target'

export type FeishuSendMode = 'auto' | 'api' | 'webhook'
export type FeishuDomain = 'feishu' | 'lark' | string

export type FeishuSendInput = {
  target: string
  message: string
  mode: FeishuSendMode
  webhook?: string
  appId?: string
  appSecret?: string
  domain?: FeishuDomain
  receiveIdType?: FeishuReceiveIdType
}

type FeishuApiCredentials = {
  appId: string
  appSecret: string
  domain: FeishuDomain
}

type FeishuApiSendResult = {
  ok: true
  mode: 'api'
  target: string
  receiveIdType: FeishuReceiveIdType
  messageId: string
  webhookUsed: false
  raw: unknown
}

type FeishuWebhookSendResult = {
  ok: true
  mode: 'webhook'
  target: string
  webhookUsed: true
  raw: unknown
}

export type FeishuSendResult = FeishuApiSendResult | FeishuWebhookSendResult

const FEISHU_TIMEOUT_MS = 30_000

const resolveApiBaseUrl = (domain: FeishuDomain) => {
  if (domain === 'lark') {
    return 'https://open.larksuite.com/open-apis'
  }

  if (!domain || domain === 'feishu') {
    return 'https://open.feishu.cn/open-apis'
  }

  return `${String(domain).replace(/\/+$/, '')}/open-apis`
}

const isGroupTarget = (receiveIdType: FeishuReceiveIdType) => receiveIdType === 'chat_id'

const hasApiCredentials = (appId?: string, appSecret?: string): appId is string =>
  Boolean(appId?.trim() && appSecret?.trim())

const coerceAxiosErrorMessage = (error: AxiosError) => {
  const data = error.response?.data as { msg?: string; message?: string; code?: number } | undefined
  const pieces = [
    typeof data?.code === 'number' ? `code=${data.code}` : '',
    data?.msg || data?.message || '',
    error.message || '',
  ].filter(Boolean)

  return pieces.join(' | ')
}

const formatUnknownError = (error: unknown) => {
  if (error instanceof AxiosError) {
    return coerceAxiosErrorMessage(error)
  }
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

const createFeishuError = (prefix: string, error: unknown) => new Error(`${prefix}: ${formatUnknownError(error)}`)

export async function fetchTenantAccessToken(credentials: FeishuApiCredentials) {
  try {
    const response = await axios.post(
      `${resolveApiBaseUrl(credentials.domain)}/auth/v3/tenant_access_token/internal`,
      {
        app_id: credentials.appId,
        app_secret: credentials.appSecret,
      },
      {
        timeout: FEISHU_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )

    const payload = response.data as { code?: number; msg?: string; tenant_access_token?: string }
    if (payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(`code=${payload.code ?? 'unknown'} ${payload.msg || 'missing tenant_access_token'}`)
    }

    return {
      token: payload.tenant_access_token,
      raw: payload,
    }
  } catch (error) {
    throw createFeishuError('Failed to fetch Feishu tenant access token', error)
  }
}

export async function sendFeishuApiMessage(params: {
  credentials: FeishuApiCredentials
  target: string
  message: string
  receiveIdType: FeishuReceiveIdType
}): Promise<FeishuApiSendResult> {
  const token = await fetchTenantAccessToken(params.credentials)

  try {
    const response = await axios.post(
      `${resolveApiBaseUrl(params.credentials.domain)}/im/v1/messages`,
      {
        receive_id: params.target,
        msg_type: 'text',
        content: JSON.stringify({ text: params.message }),
      },
      {
        timeout: FEISHU_TIMEOUT_MS,
        params: {
          receive_id_type: params.receiveIdType,
        },
        headers: {
          Authorization: `Bearer ${token.token}`,
          'Content-Type': 'application/json',
        },
      },
    )

    const payload = response.data as {
      code?: number
      msg?: string
      data?: { message_id?: string }
    }
    if (payload.code !== 0 || !payload.data?.message_id) {
      throw new Error(`code=${payload.code ?? 'unknown'} ${payload.msg || 'missing message_id'}`)
    }

    return {
      ok: true,
      mode: 'api',
      target: params.target,
      receiveIdType: params.receiveIdType,
      messageId: payload.data.message_id,
      webhookUsed: false,
      raw: payload,
    }
  } catch (error) {
    throw createFeishuError('Failed to send Feishu API message', error)
  }
}

export async function sendFeishuWebhookMessage(params: {
  webhook: string
  target: string
  message: string
}): Promise<FeishuWebhookSendResult> {
  try {
    const response = await axios.post(
      params.webhook,
      {
        msg_type: 'text',
        content: {
          text: params.message,
        },
      },
      {
        timeout: FEISHU_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )

    const payload = response.data as { code?: number; msg?: string; StatusCode?: number; StatusMessage?: string }
    const ok = payload.code === undefined ? payload.StatusCode === 0 || payload.StatusCode === undefined : payload.code === 0
    if (!ok) {
      throw new Error(
        `code=${payload.code ?? payload.StatusCode ?? 'unknown'} ${payload.msg || payload.StatusMessage || 'webhook rejected'}`,
      )
    }

    return {
      ok: true,
      mode: 'webhook',
      target: params.target,
      webhookUsed: true,
      raw: payload,
    }
  } catch (error) {
    throw createFeishuError('Failed to send Feishu webhook message', error)
  }
}

export async function sendFeishuMessage(input: FeishuSendInput): Promise<FeishuSendResult> {
  const resolvedTarget = resolveFeishuTarget(input.target, input.receiveIdType)
  const webhook = input.webhook?.trim()
  const appId = input.appId?.trim()
  const appSecret = input.appSecret?.trim()
  const domain = input.domain?.trim() || 'feishu'
  const credentialsAvailable = hasApiCredentials(appId, appSecret)

  if (input.mode === 'api') {
    if (!credentialsAvailable) {
      throw new Error('Feishu API mode requires FEISHU_APP_ID and FEISHU_APP_SECRET (or --app-id/--app-secret)')
    }
    return sendFeishuApiMessage({
      credentials: { appId, appSecret, domain },
      target: resolvedTarget.normalizedTarget,
      message: input.message,
      receiveIdType: resolvedTarget.receiveIdType,
    })
  }

  if (input.mode === 'webhook') {
    if (!webhook) {
      throw new Error('Feishu webhook mode requires FEISHU_WEBHOOK (or --webhook)')
    }
    return sendFeishuWebhookMessage({
      webhook,
      target: resolvedTarget.normalizedTarget,
      message: input.message,
    })
  }

  if (credentialsAvailable) {
    return sendFeishuApiMessage({
      credentials: { appId, appSecret, domain },
      target: resolvedTarget.normalizedTarget,
      message: input.message,
      receiveIdType: resolvedTarget.receiveIdType,
    })
  }

  if (webhook && isGroupTarget(resolvedTarget.receiveIdType)) {
    return sendFeishuWebhookMessage({
      webhook,
      target: resolvedTarget.normalizedTarget,
      message: input.message,
    })
  }

  if (webhook && !isGroupTarget(resolvedTarget.receiveIdType)) {
    throw new Error('Personal Feishu targets require app credentials; webhook fallback is only supported for group chat targets')
  }

  throw new Error(
    'Feishu auto mode requires FEISHU_APP_ID and FEISHU_APP_SECRET, or FEISHU_WEBHOOK for group chat targets',
  )
}
