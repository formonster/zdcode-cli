import axios, { AxiosError } from 'axios'
import { ChannelSendResult, OutboundChannelMessage } from '../../types'
import { resolveFeishuTarget } from './target'
import { FeishuProviderConnection, FeishuReceiveIdType } from './types'

type FeishuApiCredentials = {
  appId: string
  appSecret: string
  domain: string
}

const FEISHU_TIMEOUT_MS = 30_000

const resolveApiBaseUrl = (domain?: string) => {
  if (domain === 'lark') return 'https://open.larksuite.com/open-apis'
  if (!domain || domain === 'feishu') return 'https://open.feishu.cn/open-apis'
  return `${String(domain).replace(/\/+$/, '')}/open-apis`
}

const formatAxiosError = (error: AxiosError) => {
  const data = error.response?.data as { msg?: string; message?: string; code?: number } | undefined
  return [typeof data?.code === 'number' ? `code=${data.code}` : '', data?.msg || data?.message || '', error.message || '']
    .filter(Boolean)
    .join(' | ')
}

const formatUnknownError = (error: unknown) => {
  if (error instanceof AxiosError) return formatAxiosError(error)
  if (error instanceof Error) return error.message
  return String(error)
}

const createFeishuError = (prefix: string, error: unknown) => new Error(`${prefix}: ${formatUnknownError(error)}`)

const fetchTenantAccessToken = async (credentials: FeishuApiCredentials) => {
  try {
    const response = await axios.post(
      `${resolveApiBaseUrl(credentials.domain)}/auth/v3/tenant_access_token/internal`,
      {
        app_id: credentials.appId,
        app_secret: credentials.appSecret,
      },
      {
        timeout: FEISHU_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json' },
      },
    )

    const payload = response.data as { code?: number; msg?: string; tenant_access_token?: string }
    if (payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(`code=${payload.code ?? 'unknown'} ${payload.msg || 'missing tenant_access_token'}`)
    }

    return payload.tenant_access_token
  } catch (error) {
    throw createFeishuError('Failed to fetch Feishu tenant access token', error)
  }
}

const sendViaApi = async (params: {
  connection: FeishuProviderConnection
  target: string
  text: string
  receiveIdType: FeishuReceiveIdType
}): Promise<ChannelSendResult> => {
  const token = await fetchTenantAccessToken({
    appId: params.connection.appId,
    appSecret: params.connection.appSecret,
    domain: params.connection.domain || 'feishu',
  })

  try {
    const response = await axios.post(
      `${resolveApiBaseUrl(params.connection.domain || 'feishu')}/im/v1/messages`,
      {
        receive_id: params.target,
        msg_type: 'text',
        content: JSON.stringify({ text: params.text }),
      },
      {
        timeout: FEISHU_TIMEOUT_MS,
        params: { receive_id_type: params.receiveIdType },
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    )

    const payload = response.data as { code?: number; msg?: string; data?: { message_id?: string } }
    if (payload.code !== 0 || !payload.data?.message_id) {
      throw new Error(`code=${payload.code ?? 'unknown'} ${payload.msg || 'missing message_id'}`)
    }

    return {
      ok: true,
      provider: 'feishu',
      connectionId: params.connection.id,
      target: params.target,
      messageId: payload.data.message_id,
      raw: payload,
    }
  } catch (error) {
    throw createFeishuError('Failed to send Feishu API message', error)
  }
}

const sendViaWebhook = async (params: {
  connection: FeishuProviderConnection
  target: string
  text: string
}): Promise<ChannelSendResult> => {
  if (!params.connection.webhook?.trim()) {
    throw new Error(`Connection "${params.connection.id}" does not have a webhook configured`)
  }

  try {
    const response = await axios.post(
      params.connection.webhook,
      {
        msg_type: 'text',
        content: {
          text: params.text,
        },
      },
      {
        timeout: FEISHU_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json' },
      },
    )

    return {
      ok: true,
      provider: 'feishu',
      connectionId: params.connection.id,
      target: params.target,
      raw: response.data,
    }
  } catch (error) {
    throw createFeishuError('Failed to send Feishu webhook message', error)
  }
}

export const sendFeishuProviderMessage = async (params: {
  connection: FeishuProviderConnection
  message: OutboundChannelMessage
}) => {
  const target = resolveFeishuTarget(params.message.target)
  const canUseApi = Boolean(params.connection.appId?.trim() && params.connection.appSecret?.trim())

  if (canUseApi) {
    return sendViaApi({
      connection: params.connection,
      target: target.normalizedTarget,
      text: params.message.text,
      receiveIdType: target.receiveIdType,
    })
  }

  if (target.receiveIdType !== 'chat_id') {
    throw new Error('Feishu personal targets require app credentials; webhook-only connections support group chat targets only')
  }

  return sendViaWebhook({
    connection: params.connection,
    target: target.normalizedTarget,
    text: params.message.text,
  })
}
