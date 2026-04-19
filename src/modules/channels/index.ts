import { Command } from 'commander'
import { ensureRuntimeAvailable, fetchJson } from '../../utils/platform'
import {
  createChannelConnection,
  initChannelsStore,
  listChannelConnections,
  resolveChannelConnection,
} from './connections/store'
import { resolveChannelProvider } from './registry'
import { sendChannelMessage, startChannelConnection } from './service'
import { ChannelProviderId, FeishuChannelConnectionRecord } from './types'

type CreateConnectionOptions = {
  provider: ChannelProviderId
  id: string
  name: string
  appId?: string
  appSecret?: string
  domain?: string
  webhook?: string
  disabled?: boolean
}

type ServeOptions = {
  connection: string
  raw?: boolean
  runtime?: boolean
  entryAgent?: string
  enableAgent?: string[]
  maxTurns?: string
}

type SendOptions = {
  connection: string
  target: string
  message: string
  json?: boolean
}

type BindingCreateOptions = {
  agent: string
  connection: string
  chatId: string
  enableAgent?: string[]
  maxTurns?: string
  disablePush?: boolean
  disabled?: boolean
}

type BindingEditOptions = {
  enableAgent?: string[]
  maxTurns?: string
  disablePush?: boolean
  disabled?: boolean
  enabled?: boolean
}

type BridgeOptions = {
  pollInterval?: string
  runtimeUrl?: string
}

const printConnection = (connection: ReturnType<typeof resolveChannelConnection>) => {
  console.log(`- id: ${connection.id}`)
  console.log(`- name: ${connection.name}`)
  console.log(`- provider: ${connection.provider}`)
  console.log(`- enabled: ${connection.enabled ? 'yes' : 'no'}`)
}

const registerInitCommand = (channels: Command) => {
  channels
    .command('init')
    .description('初始化 channels 配置目录')
    .action(() => {
      try {
        const result = initChannelsStore()
        console.log('✅ Channels initialized')
        console.log(`- home: ${result.home}`)
        console.log(`- config: ${result.configPath}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`❌ ${message}`)
        process.exit(1)
      }
    })
}

const registerConnectionCommands = (channels: Command) => {
  const connection = channels.command('connection').description('管理 channels 连接')

  connection
    .command('create')
    .description('创建一个新的 channel connection')
    .requiredOption('--provider <provider>', '连接 provider，目前支持 feishu')
    .requiredOption('--id <id>', '连接 id')
    .requiredOption('--name <name>', '连接名称')
    .option('--app-id <id>', 'provider app id')
    .option('--app-secret <secret>', 'provider app secret')
    .option('--domain <domain>', 'provider domain')
    .option('--webhook <url>', 'provider webhook')
    .option('--disabled', '创建时设为 disabled', false)
    .action((options: CreateConnectionOptions) => {
      try {
        if (options.provider !== 'feishu') {
          throw new Error(`Unsupported provider: ${options.provider}`)
        }

        const record: Omit<FeishuChannelConnectionRecord, 'createdAt' | 'updatedAt'> = {
          id: options.id.trim(),
          name: options.name.trim(),
          provider: 'feishu',
          enabled: !options.disabled,
          appId: options.appId?.trim() || '',
          appSecret: options.appSecret?.trim() || '',
          domain: options.domain?.trim() || 'feishu',
          webhook: options.webhook?.trim() || '',
        }

        resolveChannelProvider(record.provider).validateConnection(record)
        const created = createChannelConnection(record)
        console.log('✅ Channel connection created')
        printConnection(created)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`❌ ${message}`)
        process.exit(1)
      }
    })

  connection
    .command('ls')
    .description('列出已配置的 channel connections')
    .action(() => {
      try {
        const connections = listChannelConnections()
        if (!connections.length) {
          console.log('No channel connections configured.')
          return
        }

        connections.forEach((item) => {
          console.log(`${item.id}\t${item.provider}\t${item.enabled ? 'enabled' : 'disabled'}\t${item.name}`)
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`❌ ${message}`)
        process.exit(1)
      }
    })
}

const registerBindingCommands = (channels: Command) => {
  const binding = channels.command('binding').description('管理 agent 与聊天会话的绑定')

  binding
    .command('ls')
    .description('列出当前 runtime 中的 channel bindings')
    .action(async () => {
      try {
        const baseUrl = await ensureRuntimeAvailable()
        const bindings = await fetchJson<any[]>(`${baseUrl}/channel-bindings`)
        if (!bindings.length) {
          console.log('No channel bindings configured.')
          return
        }
        bindings.forEach((item) => {
          console.log(
            `${item.id}\t${item.provider}\t${item.connection_id}\t${item.conversation_id}\t${item.agent_name}\t${item.enabled ? 'enabled' : 'disabled'}`,
          )
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`❌ ${message}`)
        process.exit(1)
      }
    })

  binding
    .command('create')
    .description('为 Agent 绑定一个聊天会话入口')
    .requiredOption('--agent <id>', 'Agent id')
    .requiredOption('--connection <id>', 'channel connection id')
    .requiredOption('--chat-id <id>', '聊天会话 id，例如飞书 chat_id')
    .option('--enable-agent <id>', '允许参与该会话任务的 Agent，可重复传入', (value, previous: string[] = []) => {
      previous.push(value)
      return previous
    })
    .option('--max-turns <number>', '该会话默认最大轮次数', String(30))
    .option('--disable-push', '关闭任务结果主动回推', false)
    .option('--disabled', '创建时设为 disabled', false)
    .action(async (options: BindingCreateOptions) => {
      try {
        const baseUrl = await ensureRuntimeAvailable()
        const connection = resolveChannelConnection(options.connection)
        const payload = await fetchJson(`${baseUrl}/channel-bindings`, {
          method: 'POST',
          body: JSON.stringify({
            agent_id: options.agent,
            provider: connection.provider,
            connection_id: options.connection,
            conversation_id: options.chatId,
            enabled_agent_ids: Array.from(new Set([options.agent, ...(options.enableAgent || [])])),
            max_turns: Number(options.maxTurns || 30),
            push_enabled: !options.disablePush,
            enabled: !options.disabled,
          }),
        })
        console.log('✅ Channel binding created')
        console.log(JSON.stringify(payload, null, 2))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`❌ ${message}`)
        process.exit(1)
      }
    })

  binding
    .command('edit <bindingId>')
    .description('更新一个 channel binding')
    .option('--enable-agent <id>', '覆盖允许参与该会话任务的 Agent，可重复传入', (value, previous: string[] = []) => {
      previous.push(value)
      return previous
    })
    .option('--max-turns <number>', '更新默认最大轮次数')
    .option('--disable-push', '关闭主动回推')
    .option('--enabled', '显式启用该 binding')
    .option('--disabled', '显式禁用该 binding')
    .action(async (bindingId: string, options: BindingEditOptions) => {
      try {
        const baseUrl = await ensureRuntimeAvailable()
        const patch: Record<string, unknown> = {}
        if (options.enableAgent?.length) patch.enabled_agent_ids = Array.from(new Set(options.enableAgent))
        if (options.maxTurns) patch.max_turns = Number(options.maxTurns)
        if (options.disablePush) patch.push_enabled = false
        if (options.enabled) patch.enabled = true
        if (options.disabled) patch.enabled = false
        const payload = await fetchJson(`${baseUrl}/channel-bindings/${bindingId}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        })
        console.log('✅ Channel binding updated')
        console.log(JSON.stringify(payload, null, 2))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`❌ ${message}`)
        process.exit(1)
      }
    })
}

const registerServeCommand = (channels: Command) => {
  channels
    .command('serve')
    .description('启动一个 channel 长连接；可仅输出消息，或直接转发到 runtime')
    .requiredOption('--connection <id>', '连接 id')
    .option('--raw', '同时输出原始 provider payload', false)
    .option('--runtime', '将收到的消息直接转发到 runtime', false)
    .option('--entry-agent <id>', '消息首次创建任务时默认使用的入口 Agent')
    .option('--enable-agent <id>', '首次创建任务时默认启用的参与 Agent，可重复传入', (value, previous: string[] = []) => {
      previous.push(value)
      return previous
    })
    .option('--max-turns <number>', '首次创建任务时默认的最大轮次数')
    .action(async (options: ServeOptions) => {
      try {
        const connection = resolveChannelConnection(options.connection)
        if (!connection.enabled) {
          throw new Error(`Connection "${connection.id}" is disabled`)
        }

        const runtimeBaseUrl = options.runtime ? await ensureRuntimeAvailable() : null
        await startChannelConnection({
          connectionId: connection.id,
          raw: options.raw,
          logger: (line) => console.log(line),
          onMessage: async (message) => {
            if (!runtimeBaseUrl) {
              console.log(JSON.stringify(message))
              return
            }

            const result = await fetchJson<{
              ok: boolean
              action: string
              task_id?: string
              duplicate?: boolean
              status?: string
            }>(`${runtimeBaseUrl}/channels/messages`, {
              method: 'POST',
              body: JSON.stringify({
                ...message,
                entry_agent_id: options.entryAgent,
                enabled_agent_ids: Array.from(new Set([...(options.enableAgent || []), ...(options.entryAgent ? [options.entryAgent] : [])])),
                max_turns: options.maxTurns ? Number(options.maxTurns) : undefined,
              }),
            })

            console.log(
              JSON.stringify({
                channel: message.provider,
                connection: message.connectionId,
                conversation: message.conversationId,
                message_id: message.messageId,
                runtime_action: result.action,
                task_id: result.task_id,
                duplicate: result.duplicate || false,
                status: result.status || 'accepted',
              }),
            )
          },
        })

        await new Promise<void>(() => undefined)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`❌ ${message}`)
        process.exit(1)
      }
    })
}

const registerSendCommand = (channels: Command) => {
  channels
    .command('send')
    .description('通过指定 connection 主动向聊天 App 推送消息')
    .requiredOption('--connection <id>', '连接 id')
    .requiredOption('--target <target>', '消息目标，例如 user:ou_xxx 或 chat:oc_xxx')
    .requiredOption('-m, --message <text>', '消息内容')
    .option('--json', '输出 JSON 结果', false)
    .action(async (options: SendOptions) => {
      try {
        const result = await sendChannelMessage({
          connectionId: options.connection,
          target: options.target,
          text: options.message,
        })

        if (options.json) {
          console.log(JSON.stringify(result, null, 2))
          return
        }

        console.log('✅ Channel message sent')
        console.log(`- connection: ${result.connectionId}`)
        console.log(`- provider: ${result.provider}`)
        console.log(`- target: ${result.target}`)
        if (result.messageId) {
          console.log(`- message_id: ${result.messageId}`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (options.json) {
          console.error(JSON.stringify({ ok: false, error: message }, null, 2))
        } else {
          console.error(`❌ ${message}`)
        }
        process.exit(1)
      }
    })
}

const registerBridgeCommand = (channels: Command) => {
  channels
    .command('bridge')
    .description('将 channel 入站消息桥接到 runtime，并轮询 outbox 主动回推结果')
    .option('--poll-interval <ms>', '轮询 runtime outbox 的间隔，默认 2000ms', String(2000))
    .option('--runtime-url <url>', 'runtime 地址；默认自动发现本地 runtime')
    .action(async (options: BridgeOptions) => {
      try {
        const runtimeBaseUrl = options.runtimeUrl?.trim() || (await ensureRuntimeAvailable())
        const bindingByKey = new Map<string, any>()
        const connections = new Set<string>()
        const pollInterval = Math.max(500, Number(options.pollInterval || 2000))
        let announcedWaiting = false
        const ensureListeners = async () => {
          const bindings = await fetchJson<any[]>(`${runtimeBaseUrl}/channel-bindings`)
          const activeBindings = bindings.filter((item) => item.enabled)
          bindingByKey.clear()
          activeBindings.forEach((item) => {
            bindingByKey.set(`${item.provider}:${item.connection_id}:${item.conversation_id}`, item)
          })

          for (const item of activeBindings) {
            if (connections.has(item.connection_id)) continue
            const connection = resolveChannelConnection(item.connection_id)
            if (!connection.enabled) continue
            await startChannelConnection({
              connectionId: item.connection_id,
              logger: (line) => console.log(line),
              onMessage: async (message) => {
                const binding = bindingByKey.get(`${message.provider}:${message.connectionId}:${message.conversationId}`)
                if (!binding) {
                  console.log(
                    JSON.stringify({
                      channel: message.provider,
                      connection: message.connectionId,
                      conversation: message.conversationId,
                      message_id: message.messageId,
                      runtime_action: 'ignored_unbound',
                    }),
                  )
                  return
                }

                const result = await fetchJson<any>(`${runtimeBaseUrl}/channels/messages`, {
                  method: 'POST',
                  body: JSON.stringify({
                    ...message,
                    entry_agent_id: binding.agent_id,
                    enabled_agent_ids: binding.enabled_agent_ids,
                    max_turns: binding.max_turns,
                  }),
                })

                if (result.action === 'busy' && binding.push_enabled) {
                  await sendChannelMessage({
                    connectionId: message.connectionId,
                    target: `chat:${message.conversationId}`,
                    text: '当前任务仍在运行或等待审批，请稍后再试，或发送 /new 开启一个新任务。',
                  })
                }

                console.log(
                  JSON.stringify({
                    channel: message.provider,
                    connection: message.connectionId,
                    conversation: message.conversationId,
                    message_id: message.messageId,
                    runtime_action: result.action,
                    task_id: result.task_id,
                    duplicate: result.duplicate || false,
                  }),
                )
              },
            })
            connections.add(item.connection_id)
          }
        }

        while (true) {
          try {
            await ensureListeners()
            break
          } catch (error) {
            if (!announcedWaiting) {
              const message = error instanceof Error ? error.message : String(error)
              console.log(`Waiting for runtime/channel bindings: ${message}`)
              announcedWaiting = true
            }
            await new Promise((resolve) => setTimeout(resolve, pollInterval))
          }
        }

        setInterval(async () => {
          try {
            await ensureListeners()
            const pending = await fetchJson<any[]>(`${runtimeBaseUrl}/channels/outbox?limit=50`)
            for (const item of pending) {
              try {
                await sendChannelMessage({
                  connectionId: item.connection_id,
                  target: `chat:${item.conversation_id}`,
                  text: item.text,
                })
                await fetchJson(`${runtimeBaseUrl}/channels/outbox/${item.id}/delivered`, {
                  method: 'POST',
                  body: JSON.stringify({}),
                })
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                await fetchJson(`${runtimeBaseUrl}/channels/outbox/${item.id}/failed`, {
                  method: 'POST',
                  body: JSON.stringify({ error: message }),
                })
              }
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`❌ bridge poll failed: ${message}`)
          }
        }, pollInterval)

        console.log(`✅ Channels bridge started (${connections.size} connection(s))`)
        await new Promise<void>(() => undefined)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`❌ ${message}`)
        process.exit(1)
      }
    })
}

export default function channelsModule(program: Command) {
  const channels = program.command('channels').description('统一聊天渠道接入层')
  registerInitCommand(channels)
  registerConnectionCommands(channels)
  registerBindingCommands(channels)
  registerServeCommand(channels)
  registerSendCommand(channels)
  registerBridgeCommand(channels)
}
