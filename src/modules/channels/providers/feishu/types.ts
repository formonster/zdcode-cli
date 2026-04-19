import { FeishuChannelConnectionRecord } from '../../types'

export type FeishuReceiveIdType = 'open_id' | 'user_id' | 'chat_id'

export type FeishuMessageReceiveEvent = {
  sender?: {
    sender_id?: {
      open_id?: string
      user_id?: string
      union_id?: string
    }
  }
  message?: {
    message_id?: string
    chat_id?: string
    chat_type?: 'p2p' | 'group' | 'private'
    message_type?: string
    content?: string
    create_time?: string
  }
}

export type ParsedFeishuIncomingMessage = {
  chatId: string
  messageId: string
  senderId: string
  text: string
  timestamp: string
  rawEvent?: unknown
}

export type ResolvedFeishuTarget = {
  rawTarget: string
  normalizedTarget: string
  receiveIdType: FeishuReceiveIdType
}

export type FeishuProviderConnection = FeishuChannelConnectionRecord
