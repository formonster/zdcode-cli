import * as Lark from '@larksuiteoapi/node-sdk'
import { ChannelConnectionHandle, ChannelMessageHandler, InboundChannelMessage } from '../../types'
import { FeishuMessageReceiveEvent, FeishuProviderConnection, ParsedFeishuIncomingMessage } from './types'

const resolveDomain = (domain?: string) => {
  if (!domain || domain === 'feishu') return Lark.Domain.Feishu
  if (domain === 'lark') return Lark.Domain.Lark
  return domain.replace(/\/+$/, '')
}

const parseMessageContent = (messageType?: string, rawContent?: string) => {
  if (!rawContent) return ''

  try {
    const parsed = JSON.parse(rawContent) as string | { text?: string; title?: string; content?: string; zh_cn?: { content?: unknown[] } }
    if (typeof parsed === 'string') return parsed
    if (messageType === 'text' && typeof parsed.text === 'string') return parsed.text
    if (messageType === 'post') {
      const lines: string[] = []
      const content = parsed.zh_cn?.content
      if (Array.isArray(content)) {
        for (const row of content) {
          if (!Array.isArray(row)) continue
          for (const item of row) {
            if (!item || typeof item !== 'object') continue
            const text = (item as { text?: string }).text
            if (typeof text === 'string' && text.trim()) lines.push(text)
          }
        }
      }
      return lines.join('').trim() || '[post message]'
    }
    if (typeof parsed.text === 'string' && parsed.text.trim()) return parsed.text
    if (typeof parsed.title === 'string' && parsed.title.trim()) return parsed.title
    if (typeof parsed.content === 'string' && parsed.content.trim()) return parsed.content
  } catch {
    return rawContent
  }

  return rawContent
}

const formatTimestamp = (raw?: string) => {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return new Date().toISOString()
  return new Date(value).toISOString()
}

const normalizeIncomingFeishuMessage = (event: FeishuMessageReceiveEvent): ParsedFeishuIncomingMessage | null => {
  const message = event.message || {}
  const chatId = message.chat_id?.trim()
  const messageId = message.message_id?.trim()
  if (!chatId || !messageId) return null

  const senderId = event.sender?.sender_id?.open_id || event.sender?.sender_id?.user_id || event.sender?.sender_id?.union_id || 'unknown'
  const text = parseMessageContent(message.message_type, message.content).trim()

  return {
    chatId,
    messageId,
    senderId,
    text: text || `[${message.message_type || 'unknown'} message]`,
    timestamp: formatTimestamp(message.create_time),
    rawEvent: event,
  }
}

const toInboundMessage = (connection: FeishuProviderConnection, message: ParsedFeishuIncomingMessage): InboundChannelMessage => ({
  provider: 'feishu',
  connectionId: connection.id,
  conversationId: message.chatId,
  messageId: message.messageId,
  senderId: message.senderId,
  text: message.text,
  receivedAt: message.timestamp,
  raw: message.rawEvent,
})

export const startFeishuProviderConnection = async (params: {
  connection: FeishuProviderConnection
  onMessage: ChannelMessageHandler
  raw?: boolean
  logger?: (line: string) => void
}): Promise<ChannelConnectionHandle> => {
  const { connection, onMessage, raw, logger } = params
  if (!connection.appId?.trim() || !connection.appSecret?.trim()) {
    throw new Error(`Feishu connection "${connection.id}" requires appId and appSecret for long-lived listening`)
  }

  const client = new Lark.WSClient({
    appId: connection.appId,
    appSecret: connection.appSecret,
    domain: resolveDomain(connection.domain),
    loggerLevel: Lark.LoggerLevel.info,
  })
  const dispatcher = new Lark.EventDispatcher({})

  dispatcher.register({
    'im.message.receive_v1': async (data: unknown) => {
      const parsed = normalizeIncomingFeishuMessage(data as FeishuMessageReceiveEvent)
      if (!parsed) return
      if (raw && logger) {
        logger(JSON.stringify(data))
      }
      await onMessage(toInboundMessage(connection, parsed))
    },
  })

  client.start({ eventDispatcher: dispatcher })
  logger?.(`[${new Date().toISOString()}] channels connection=${connection.id} provider=feishu started`)

  const stop = async () => {
    try {
      await client.stop()
    } catch {
      // ignore stop errors
    }
    logger?.(`[${new Date().toISOString()}] channels connection=${connection.id} provider=feishu stopped`)
  }

  const stopSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
  const stopHandler = () => {
    void stop()
  }
  stopSignals.forEach((signal) => process.once(signal, stopHandler))

  return {
    stop: async () => {
      stopSignals.forEach((signal) => process.off(signal, stopHandler))
      await stop()
    },
  }
}
