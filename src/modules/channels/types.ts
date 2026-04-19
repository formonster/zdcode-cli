export type ChannelProviderId = 'feishu'

export type ChannelConnectionRecordBase = {
  id: string
  name: string
  provider: ChannelProviderId
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export type FeishuChannelConnectionRecord = ChannelConnectionRecordBase & {
  provider: 'feishu'
  appId: string
  appSecret: string
  domain?: string
  webhook?: string
}

export type ChannelConnectionRecord = FeishuChannelConnectionRecord

export type InboundChannelMessage = {
  provider: ChannelProviderId
  connectionId: string
  conversationId: string
  messageId: string
  senderId: string
  text: string
  receivedAt: string
  raw?: unknown
}

export type OutboundChannelMessage = {
  provider: ChannelProviderId
  connectionId: string
  target: string
  text: string
  replyToMessageId?: string
}

export type ChannelSendResult = {
  ok: true
  provider: ChannelProviderId
  connectionId: string
  target: string
  messageId?: string
  raw?: unknown
}

export type ChannelMessageHandler = (message: InboundChannelMessage) => Promise<void> | void

export type ChannelConnectionHandle = {
  stop: () => Promise<void>
}

export type ChannelProvider<TConnection extends ChannelConnectionRecord = ChannelConnectionRecord> = {
  id: TConnection['provider']
  validateConnection: (connection: TConnection) => void
  startConnection: (params: {
    connection: TConnection
    onMessage: ChannelMessageHandler
    raw?: boolean
    logger?: (line: string) => void
  }) => Promise<ChannelConnectionHandle>
  sendMessage: (params: {
    connection: TConnection
    message: OutboundChannelMessage
  }) => Promise<ChannelSendResult>
}
