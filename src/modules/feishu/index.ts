import { Command } from 'commander'
import {
  createFeishuBot,
  initFeishuConfigHome,
  LoadedFeishuBot,
  resolveAllEnabledBots,
  resolveConfiguredBot,
  ZDCODE_FEISHU_CONFIG_PATH,
} from './config'
import { serveFeishuMessages } from './receive'
import { sendFeishuMessage } from './send'
import { FeishuReceiveIdType, resolveFeishuTarget } from './target'

type SendOptions = {
  bot?: string
  target: string
  message: string
  mode?: 'auto' | 'api' | 'webhook'
  webhook?: string
  appId?: string
  appSecret?: string
  domain?: string
  receiveIdType?: FeishuReceiveIdType
  json?: boolean
}

type ServeOptions = {
  bot?: string
  appId?: string
  appSecret?: string
  domain?: string
  logFile?: string
  raw?: boolean
}

type CreateBotOptions = {
  name: string
  appId?: string
  appSecret?: string
  domain?: string
  webhook?: string
  logFile?: string
  allowChatId?: string[]
}

const resolveBotRuntime = (botName?: string): LoadedFeishuBot => {
  if (!botName?.trim()) {
    throw new Error('Feishu send requires --bot <name>. Configure bots in ~/.zdcode/feishu/config.json')
  }
  return resolveConfiguredBot(botName.trim())
}

const printInitResult = (result: ReturnType<typeof initFeishuConfigHome>) => {
  console.log('✅ Feishu config initialized')
  console.log(`- config: ${result.configPath}`)
  console.log(`- botsDir: ${result.botsDir}`)
  if (result.created.length) {
    console.log(`- created:`)
    result.created.forEach((item) => console.log(`  - ${item}`))
  } else {
    console.log('- created: none (existing files preserved)')
  }
}

const printResult = (
  bot: LoadedFeishuBot,
  result: Awaited<ReturnType<typeof sendFeishuMessage>>,
  json?: boolean,
) => {
  const payload =
    result.mode === 'api'
      ? { ...result, bot: bot.name }
      : { ...result, bot: bot.name }

  if (json) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  if (result.mode === 'api') {
    console.log('✅ Feishu message sent')
    console.log(`- bot: ${bot.name}`)
    console.log(`- mode: ${result.mode}`)
    console.log(`- target: ${result.target}`)
    console.log(`- receive_id_type: ${result.receiveIdType}`)
    console.log(`- message_id: ${result.messageId}`)
    return
  }

  console.log('✅ Feishu webhook message sent')
  console.log(`- bot: ${bot.name}`)
  console.log(`- mode: ${result.mode}`)
  console.log(`- target: ${result.target}`)
}

const registerInitCommand = (feishu: Command) => {
  feishu
    .command('init')
    .description('初始化多飞书机器人全局配置与 bot workspace')
    .action(() => {
      try {
        const result = initFeishuConfigHome()
        printInitResult(result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`❌ ${message}`)
        process.exit(1)
      }
    })
}

const registerCreateBotCommand = (feishu: Command) => {
  feishu
    .command('create-bot')
    .description('创建一个新的飞书机器人配置与 workspace')
    .requiredOption('--name <name>', '机器人名称，例如 白豆腐')
    .option('--app-id <id>', '飞书自建应用 app_id，不传则写入占位值')
    .option('--app-secret <secret>', '飞书自建应用 app_secret，不传则写入占位值')
    .option('--domain <domain>', '飞书域名，默认 feishu')
    .option('--webhook <url>', '可选 webhook 地址')
    .option('--log-file <path>', '可选日志文件路径，不传则自动生成')
    .option('--allow-chat-id <id>', '预置允许的 chat_id，可重复传入', (value, previous: string[] = []) => {
      previous.push(value)
      return previous
    })
    .addHelpText(
      'after',
      `
Examples:
  $ zdcode feishu create-bot --name 白豆腐
  $ zdcode feishu create-bot --name 客服助手 --app-id cli_xxx --app-secret secret_xxx
  $ zdcode feishu create-bot --name 销售机器人 --allow-chat-id oc_xxx --allow-chat-id oc_yyy
`,
    )
    .action((options: CreateBotOptions) => {
      try {
        const result = createFeishuBot({
          name: options.name,
          appId: options.appId,
          appSecret: options.appSecret,
          domain: options.domain,
          webhook: options.webhook,
          logFile: options.logFile,
          allowChatIds: options.allowChatId,
        })

        console.log('✅ Feishu bot created')
        console.log(`- bot: ${result.botName}`)
        console.log(`- config: ${result.configPath}`)
        console.log(`- workspace: ${result.workspaceDir}`)
        if (result.createdFiles.length) {
          console.log(`- created:`)
          result.createdFiles.forEach((item) => console.log(`  - ${item}`))
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`❌ ${message}`)
        process.exit(1)
      }
    })
}

const registerSendCommand = (feishu: Command) => {
  feishu
    .command('send')
    .description('发送飞书消息')
    .requiredOption('--bot <name>', '机器人名称，对应 ~/.zdcode/feishu/config.json 中的 bots.<name>')
    .requiredOption('--target <id>', '飞书接收目标，例如 ou_xxx、user:ou_xxx、chat:oc_xxx')
    .requiredOption('-m, --message <text>', '消息内容')
    .option('--mode <mode>', '发送模式：auto | api | webhook', 'auto')
    .option('--webhook <url>', '飞书机器人 webhook，覆盖 bot 配置与 FEISHU_WEBHOOK')
    .option('--app-id <id>', '飞书自建应用 app_id，覆盖 bot 配置与 FEISHU_APP_ID')
    .option('--app-secret <secret>', '飞书自建应用 app_secret，覆盖 bot 配置与 FEISHU_APP_SECRET')
    .option('--domain <domain>', '飞书域名，覆盖 bot 配置与 FEISHU_DOMAIN')
    .option('--receive-id-type <type>', '显式指定 receive_id_type: open_id | user_id | chat_id')
    .option('--json', '以 JSON 格式输出结果', false)
    .addHelpText(
      'after',
      `
Examples:
  $ zdcode feishu send --bot default --target ou_xxx --message "你好"
  $ zdcode feishu send --bot sales --target chat:oc_xxx --message "群通知"
  $ zdcode feishu send --bot default --mode webhook --target chat:oc_xxx --message "机器人通知"
`,
    )
    .action(async (options: SendOptions) => {
      try {
        const mode = options.mode || 'auto'
        if (!['auto', 'api', 'webhook'].includes(mode)) {
          throw new Error(`Invalid Feishu mode: ${options.mode}`)
        }

        const bot = resolveBotRuntime(options.bot)
        const resolvedTarget = resolveFeishuTarget(options.target, options.receiveIdType)
        const result = await sendFeishuMessage({
          target: options.target,
          message: options.message,
          mode,
          webhook: options.webhook || bot.config.webhook || process.env.FEISHU_WEBHOOK,
          appId: options.appId || bot.config.appId || process.env.FEISHU_APP_ID,
          appSecret: options.appSecret || bot.config.appSecret || process.env.FEISHU_APP_SECRET,
          domain: options.domain || bot.config.domain || process.env.FEISHU_DOMAIN || 'feishu',
          receiveIdType: resolvedTarget.receiveIdType,
        })

        printResult(bot, result, options.json)
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

const runSingleBotServe = async (bot: LoadedFeishuBot, options: ServeOptions) => {
  await serveFeishuMessages({
    bot,
    appId: options.appId || bot.config.appId || process.env.FEISHU_APP_ID,
    appSecret: options.appSecret || bot.config.appSecret || process.env.FEISHU_APP_SECRET,
    domain: options.domain || bot.config.domain || process.env.FEISHU_DOMAIN || 'feishu',
    logFile: options.logFile || bot.config.receive?.logFile,
    raw: options.raw,
  })
}

const registerServeCommand = (feishu: Command) => {
  feishu
    .command('serve')
    .description('启动飞书 WebSocket 接收器，收到消息后桥接到本地 Codex 并回发结果')
    .option('--bot <name>', '只监听单个机器人；不传则监听全部 enabled bots')
    .option('--app-id <id>', '飞书自建应用 app_id，覆盖 bot 配置与 FEISHU_APP_ID')
    .option('--app-secret <secret>', '飞书自建应用 app_secret，覆盖 bot 配置与 FEISHU_APP_SECRET')
    .option('--domain <domain>', '飞书域名，覆盖 bot 配置与 FEISHU_DOMAIN')
    .option('--log-file <path>', '收到消息后统一追加写入该日志文件')
    .option('--raw', '打印原始事件 JSON', false)
    .addHelpText(
      'after',
      `
Examples:
  $ zdcode feishu serve --bot default
  $ zdcode feishu serve
  $ zdcode feishu serve --log-file /tmp/zdcode-feishu.log
`,
    )
    .action(async (options: ServeOptions) => {
      try {
        if (options.bot?.trim()) {
          const bot = resolveConfiguredBot(options.bot.trim())
          await runSingleBotServe(bot, options)
          return
        }

        const bots = resolveAllEnabledBots()
        if (!bots.length) {
          throw new Error(`No enabled Feishu bots found in ${ZDCODE_FEISHU_CONFIG_PATH}`)
        }

        await Promise.all(bots.map((bot) => runSingleBotServe(bot, options)))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`❌ ${message}`)
        process.exit(1)
      }
    })
}

const registerFeishuModule = (program: Command) => {
  const feishu = program.command('feishu').description('飞书发送与通知工具')
  registerInitCommand(feishu)
  registerCreateBotCommand(feishu)
  registerSendCommand(feishu)
  registerServeCommand(feishu)
}

export default registerFeishuModule
