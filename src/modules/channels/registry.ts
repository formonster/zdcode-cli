import { ChannelProvider, ChannelProviderId } from './types'
import { feishuChannelProvider } from './providers/feishu'

const providers: Record<ChannelProviderId, ChannelProvider> = {
  feishu: feishuChannelProvider,
}

export const resolveChannelProvider = (providerId: ChannelProviderId) => {
  const provider = providers[providerId]
  if (!provider) {
    throw new Error(`Unsupported channel provider: ${providerId}`)
  }
  return provider
}
