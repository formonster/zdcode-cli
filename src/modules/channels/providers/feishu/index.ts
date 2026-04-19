import { ChannelProvider } from '../../types'
import { startFeishuProviderConnection } from './connect'
import { sendFeishuProviderMessage } from './send'
import { FeishuProviderConnection } from './types'

export const feishuChannelProvider: ChannelProvider<FeishuProviderConnection> = {
  id: 'feishu',
  validateConnection: (connection) => {
    if (!connection.id.trim()) throw new Error('Feishu connection id is required')
    if (!connection.name.trim()) throw new Error('Feishu connection name is required')
    if (!connection.appId?.trim() && !connection.webhook?.trim()) {
      throw new Error('Feishu connection requires app credentials or webhook')
    }
    if (connection.appId?.trim() && !connection.appSecret?.trim()) {
      throw new Error('Feishu connection with appId also requires appSecret')
    }
  },
  startConnection: startFeishuProviderConnection,
  sendMessage: sendFeishuProviderMessage,
}
