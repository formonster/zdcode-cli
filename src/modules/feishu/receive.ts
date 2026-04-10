import fs from 'fs'
import path from 'path'
import * as Lark from '@larksuiteoapi/node-sdk'
import { LoadedFeishuBot } from './config'
import { handleFeishuCodexBridge, ParsedFeishuIncomingMessage } from './codex'

export type FeishuServeInput = {
  bot: LoadedFeishuBot
  appId?: string
  appSecret?: string
  domain?: string
  logFile?: string
  raw?: boolean
}

type FeishuServeLogger = {
  log: (line: string) => void
  close: () => void
}

export type FeishuMessageReceiveEvent = {
  sender?: {
    sender_id?: {
      open_id?: string
      user_id?: string
      union_id?: string
    }
    sender_type?: string
    tenant_key?: string
  }
  message?: {
    message_id?: string
    chat_id?: string
    chat_type?: 'p2p' | 'group' | 'private'
    message_type?: string
    content?: string
    create_time?: string
    mentions?: Array<{
      key?: string
      name?: string
      id?: {
        open_id?: string
        user_id?: string
        union_id?: string
      }
    }>
  }
}

const resolveDomain = (domain?: string) => {
  if (!domain || domain === 'feishu') {
    return Lark.Domain.Feishu
  }
  if (domain === 'lark') {
    return Lark.Domain.Lark
  }
  return domain.replace(/\/+$/, '')
}

const parseMessageContent = (messageType?: string, rawContent?: string) => {
  if (!rawContent) {
    return ''
  }

  try {
    const parsed = JSON.parse(rawContent) as
      | string
      | { text?: string; title?: string; content?: string; zh_cn?: { title?: string; content?: unknown[] } }

    if (typeof parsed === 'string') {
      return parsed
    }

    if (messageType === 'text' && typeof parsed.text === 'string') {
      return parsed.text
    }

    if (messageType === 'post') {
      const lines: string[] = []
      const content = parsed.zh_cn?.content
      if (Array.isArray(content)) {
        for (const row of content) {
          if (!Array.isArray(row)) continue
          for (const item of row) {
            if (!item || typeof item !== 'object') continue
            const text = (item as { text?: string }).text
            if (typeof text === 'string' && text.trim()) {
              lines.push(text)
            }
          }
        }
      }
      return lines.join('').trim() || '[post message]'
    }

    if (typeof parsed.text === 'string' && parsed.text.trim()) {
      return parsed.text
    }

    if (typeof parsed.title === 'string' && parsed.title.trim()) {
      return parsed.title
    }

    if (typeof parsed.content === 'string' && parsed.content.trim()) {
      return parsed.content
    }
  } catch {
    return rawContent
  }

  return rawContent
}

export const normalizeIncomingFeishuMessage = (
  event: FeishuMessageReceiveEvent,
): ParsedFeishuIncomingMessage | null => {
  const message = event.message || {}
  const chatId = message.chat_id?.trim()
  const messageId = message.message_id?.trim()
  if (!chatId || !messageId) {
    return null
  }

  const senderId =
    event.sender?.sender_id?.open_id ||
    event.sender?.sender_id?.user_id ||
    event.sender?.sender_id?.union_id ||
    'unknown'
  const text = parseMessageContent(message.message_type, message.content).trim()

  return {
    chatId,
    chatType: message.chat_type || 'unknown',
    messageId,
    senderId,
    text: text || `[${message.message_type || 'unknown'} message]`,
    timestamp: formatTimestamp(message.create_time),
    rawEvent: event,
  }
}

const formatTimestamp = (raw?: string) => {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    return new Date().toISOString()
  }
  return new Date(value).toISOString()
}

const ensureParentDir = (filePath: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

const createServeLogger = (logFile?: string): FeishuServeLogger => {
  let stream: fs.WriteStream | null = null

  if (logFile?.trim()) {
    const resolvedPath = path.resolve(logFile)
    ensureParentDir(resolvedPath)
    stream = fs.createWriteStream(resolvedPath, { flags: 'a' })
  }

  return {
    log: (line: string) => {
      console.log(line)
      if (stream) {
        stream.write(`${line}\n`)
      }
    },
    close: () => {
      stream?.end()
      stream = null
    },
  }
}

const formatEventLine = (botName: string, message: ParsedFeishuIncomingMessage) => {
  return [
    `[${message.timestamp}]`,
    `bot=${botName}`,
    `chat=${message.chatId}`,
    `chatType=${message.chatType}`,
    `sender=${message.senderId}`,
    `messageId=${message.messageId}`,
    `text=${JSON.stringify(message.text)}`,
  ].join(' ')
}

const runBridgeInBackground = (params: {
  bot: LoadedFeishuBot
  message: ParsedFeishuIncomingMessage
  appId: string
  appSecret: string
  domain: string
  logger: FeishuServeLogger['log']
}) => {
  void Promise.resolve()
    .then(() =>
      handleFeishuCodexBridge({
        bot: params.bot,
        message: params.message,
        appId: params.appId,
        appSecret: params.appSecret,
        domain: params.domain,
        logger: params.logger,
      }),
    )
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      params.logger(`[${new Date().toISOString()}] bot=${params.bot.name} codex bridge error: ${message}`)
    })
}

export async function serveFeishuMessages(input: FeishuServeInput): Promise<void> {
  const appId = input.appId?.trim()
  const appSecret = input.appSecret?.trim()
  if (!appId || !appSecret) {
    throw new Error('Feishu serve mode requires FEISHU_APP_ID and FEISHU_APP_SECRET (or --app-id/--app-secret)')
  }

  const logger = createServeLogger(input.logFile)
  const client = new Lark.WSClient({
    appId,
    appSecret,
    domain: resolveDomain(input.domain),
    loggerLevel: Lark.LoggerLevel.info,
  })
  const dispatcher = new Lark.EventDispatcher({})

  dispatcher.register({
    'im.message.receive_v1': async (data: unknown) => {
      const event = data as FeishuMessageReceiveEvent
      const parsed = normalizeIncomingFeishuMessage(event)
      if (!parsed) {
        logger.log(`[${new Date().toISOString()}] bot=${input.bot.name} ignored malformed incoming event`)
        return
      }

      logger.log(formatEventLine(input.bot.name, parsed))
      if (input.raw) {
        logger.log(JSON.stringify(event, null, 2))
      }

      const allowChatIds = input.bot.config.routing?.allowChatIds?.filter(Boolean) || []
      if (allowChatIds.length && !allowChatIds.includes(parsed.chatId)) {
        logger.log(
          `[${new Date().toISOString()}] bot=${input.bot.name} skipped chat=${parsed.chatId} because it is not in routing.allowChatIds`,
        )
        return
      }

      if (!parsed.text.trim()) {
        logger.log(`[${new Date().toISOString()}] bot=${input.bot.name} skipped empty text message`)
        return
      }

      logger.log(
        `[${new Date().toISOString()}] bot=${input.bot.name} queued chat=${parsed.chatId} messageId=${parsed.messageId} for background processing`,
      )

      runBridgeInBackground({
        bot: input.bot,
        message: parsed,
        appId,
        appSecret,
        domain: input.domain || 'feishu',
        logger: logger.log,
      })
    },
    'im.chat.member.bot.added_v1': async (data: unknown) => {
      logger.log(`[${new Date().toISOString()}] bot=${input.bot.name} bot added event ${JSON.stringify(data)}`)
    },
    'im.chat.member.bot.deleted_v1': async (data: unknown) => {
      logger.log(`[${new Date().toISOString()}] bot=${input.bot.name} bot removed event ${JSON.stringify(data)}`)
    },
  })

  let stopping = false
  const shutdown = (signal: string) => {
    if (stopping) return
    stopping = true
    logger.log(`[${new Date().toISOString()}] bot=${input.bot.name} stopping Feishu websocket listener (${signal})`)
    try {
      client.close({ force: true })
    } finally {
      logger.close()
      process.exit(0)
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  logger.log(`[${new Date().toISOString()}] bot=${input.bot.name} starting Feishu websocket listener`)
  await client.start({ eventDispatcher: dispatcher })
}
