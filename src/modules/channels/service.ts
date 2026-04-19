import { resolveChannelConnection } from './connections/store'
import { resolveChannelProvider } from './registry'
import { ChannelConnectionHandle, ChannelMessageHandler, OutboundChannelMessage } from './types'

export const startChannelConnection = async (params: {
  connectionId: string
  onMessage: ChannelMessageHandler
  raw?: boolean
  logger?: (line: string) => void
}): Promise<ChannelConnectionHandle> => {
  const connection = resolveChannelConnection(params.connectionId)
  const provider = resolveChannelProvider(connection.provider)
  provider.validateConnection(connection)
  return provider.startConnection({
    connection,
    onMessage: params.onMessage,
    raw: params.raw,
    logger: params.logger,
  })
}

export const sendChannelMessage = async (params: {
  connectionId: string
  target: string
  text: string
  replyToMessageId?: string
}) => {
  const connection = resolveChannelConnection(params.connectionId)
  const provider = resolveChannelProvider(connection.provider)
  provider.validateConnection(connection)

  const message: OutboundChannelMessage = {
    provider: connection.provider,
    connectionId: connection.id,
    target: params.target,
    text: params.text,
    replyToMessageId: params.replyToMessageId,
  }

  return provider.sendMessage({
    connection,
    message,
  })
}
