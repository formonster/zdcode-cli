import fs from 'fs'
import os from 'os'
import path from 'path'

export type FeishuBotDocuments = {
  bot: string
  personality: string
  duties: string
  skills: string
  notes: string
}

export type FeishuBotConfig = {
  enabled: boolean
  appId: string
  appSecret: string
  domain?: string
  webhook?: string
  workspaceDir?: string
  codex?: {
    enabled?: boolean
    replyMode?: 'final_only' | 'final_and_log' | 'stream_progress'
    fullAuto?: boolean
    extraArgs?: string[]
  }
  receive?: {
    logFile?: string
  }
  routing?: {
    allowChatIds?: string[]
  }
}

export type FeishuGlobalConfig = {
  version: 1
  defaultBot?: string
  bots: Record<string, FeishuBotConfig>
}

export type LoadedFeishuBot = {
  name: string
  config: FeishuBotConfig
  workspaceDir: string
  documents: FeishuBotDocuments
}

const CONFIG_VERSION = 1 as const
const BOT_FILE_NAMES = {
  bot: 'BOT.md',
  personality: 'PERSONALITY.md',
  duties: 'DUTIES.md',
  skills: 'SKILLS.md',
  notes: 'NOTES.md',
} as const

export const ZDCODE_FEISHU_HOME = path.join(os.homedir(), '.zdcode', 'feishu')
export const ZDCODE_FEISHU_BOTS_DIR = path.join(ZDCODE_FEISHU_HOME, 'bots')
export const ZDCODE_FEISHU_CONFIG_PATH = path.join(ZDCODE_FEISHU_HOME, 'config.json')
export const ZDCODE_FEISHU_LOGS_DIR = path.join(ZDCODE_FEISHU_HOME, 'logs')

const sanitizeBotDirName = (botName: string) => {
  const trimmed = botName.trim()
  const normalized = trimmed
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()

  if (normalized) {
    return normalized
  }

  return `bot-${Buffer.from(botName).toString('hex').slice(0, 12)}`
}

export const resolveDefaultBotWorkspaceDir = (botName: string) =>
  path.join(ZDCODE_FEISHU_BOTS_DIR, sanitizeBotDirName(botName))

export const resolveDefaultBotLogFile = (botName: string) =>
  path.join(ZDCODE_FEISHU_LOGS_DIR, `${sanitizeBotDirName(botName)}.log`)

export const resolveBotSessionsFile = (workspaceDir: string) => path.join(workspaceDir, 'sessions.json')

export const resolveBotRunsDir = (workspaceDir: string) => path.join(workspaceDir, 'runs')

const ensureDir = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true })
}

const readTextIfExists = (filePath: string) => {
  if (!fs.existsSync(filePath)) {
    return ''
  }
  return fs.readFileSync(filePath, 'utf-8')
}

const writeFileIfMissing = (filePath: string, content: string) => {
  if (fs.existsSync(filePath)) {
    return false
  }
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, content, 'utf-8')
  return true
}

const createSampleWorkspaceFiles = (workspaceDir: string, botName: string) => {
  const createdFiles: string[] = []
  const templates: Record<keyof FeishuBotDocuments, string> = {
    bot: `# ${botName}\n\n这是 ${botName} 机器人的身份说明。\n`,
    personality: `# Personality\n\n- 风格：清晰、稳定、友好\n- 语气：专业但自然\n`,
    duties: `# Duties\n\n- 负责处理分配给 ${botName} 的飞书消息\n- 遵守该 bot 的职责边界\n`,
    skills: `# Skills\n\n- 记录该 bot 可用的能力、工具与限制\n`,
    notes: `# Notes\n\n- 这里放补充说明、运行约束或上下文\n`,
  }

  for (const [key, fileName] of Object.entries(BOT_FILE_NAMES) as Array<[keyof FeishuBotDocuments, string]>) {
    const filePath = path.join(workspaceDir, fileName)
    if (writeFileIfMissing(filePath, templates[key])) {
      createdFiles.push(filePath)
    }
  }

  return createdFiles
}

const createDefaultConfig = (): FeishuGlobalConfig => {
  return {
    version: CONFIG_VERSION,
    defaultBot: 'default',
    bots: {
      default: {
        enabled: true,
        appId: 'your_feishu_app_id',
        appSecret: 'your_feishu_app_secret',
        domain: 'feishu',
        codex: {
          enabled: true,
          replyMode: 'stream_progress',
          fullAuto: true,
          extraArgs: [],
        },
        routing: {
          allowChatIds: [],
        },
      },
    },
  }
}

export function initFeishuConfigHome() {
  ensureDir(ZDCODE_FEISHU_HOME)
  ensureDir(ZDCODE_FEISHU_BOTS_DIR)
  ensureDir(ZDCODE_FEISHU_LOGS_DIR)

  const created: string[] = []
  if (!fs.existsSync(ZDCODE_FEISHU_CONFIG_PATH)) {
    const defaultConfig = createDefaultConfig()
    fs.writeFileSync(ZDCODE_FEISHU_CONFIG_PATH, `${JSON.stringify(defaultConfig, null, 2)}\n`, 'utf-8')
    created.push(ZDCODE_FEISHU_CONFIG_PATH)
  }

  const config = readFeishuConfig()
  for (const [botName, botConfig] of Object.entries(config.bots)) {
    const workspaceDir = botConfig.workspaceDir?.trim()
      ? path.resolve(botConfig.workspaceDir)
      : resolveDefaultBotWorkspaceDir(botName)
    ensureDir(workspaceDir)
    const files = createSampleWorkspaceFiles(workspaceDir, botName)
    created.push(...files)
  }

  return {
    configPath: ZDCODE_FEISHU_CONFIG_PATH,
    botsDir: ZDCODE_FEISHU_BOTS_DIR,
    created,
    config,
  }
}

export function createFeishuBot(params: {
  name: string
  appId?: string
  appSecret?: string
  domain?: string
  webhook?: string
  allowChatIds?: string[]
  logFile?: string
}) {
  const botName = params.name.trim()
  if (!botName) {
    throw new Error('Bot name is required')
  }

  ensureDir(ZDCODE_FEISHU_HOME)
  ensureDir(ZDCODE_FEISHU_BOTS_DIR)

  const config = readFeishuConfig()
  if (config.bots[botName]) {
    throw new Error(`Feishu bot "${botName}" already exists`)
  }

  const dirName = sanitizeBotDirName(botName)
  const workspaceDir = resolveDefaultBotWorkspaceDir(botName)
  ensureDir(workspaceDir)

  config.bots[botName] = {
    enabled: true,
    appId: params.appId?.trim() || `replace_with_${dirName}_app_id`,
    appSecret: params.appSecret?.trim() || `replace_with_${dirName}_app_secret`,
    domain: params.domain?.trim() || 'feishu',
    codex: {
      enabled: true,
      replyMode: 'stream_progress',
      fullAuto: true,
      extraArgs: [],
    },
    ...(params.webhook?.trim() ? { webhook: params.webhook.trim() } : {}),
    ...(params.logFile?.trim()
      ? {
          receive: {
            logFile: params.logFile.trim(),
          },
        }
      : {}),
    routing: {
      allowChatIds: params.allowChatIds?.filter(Boolean) || [],
    },
  }

  fs.writeFileSync(ZDCODE_FEISHU_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
  const createdFiles = createSampleWorkspaceFiles(workspaceDir, botName)

  return {
    botName,
    workspaceDir,
    configPath: ZDCODE_FEISHU_CONFIG_PATH,
    createdFiles,
  }
}

export function readFeishuConfig(): FeishuGlobalConfig {
  if (!fs.existsSync(ZDCODE_FEISHU_CONFIG_PATH)) {
    throw new Error(`Feishu config not found. Run "zdcode feishu init" first: ${ZDCODE_FEISHU_CONFIG_PATH}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(ZDCODE_FEISHU_CONFIG_PATH, 'utf-8'))
  } catch (error) {
    throw new Error(`Invalid Feishu config JSON: ${ZDCODE_FEISHU_CONFIG_PATH}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid Feishu config shape: ${ZDCODE_FEISHU_CONFIG_PATH}`)
  }

  const config = parsed as Partial<FeishuGlobalConfig>
  if (config.version !== CONFIG_VERSION) {
    throw new Error(`Unsupported Feishu config version: ${String(config.version)}`)
  }
  if (!config.bots || typeof config.bots !== 'object' || Array.isArray(config.bots)) {
    throw new Error(`Feishu config must contain a "bots" object`)
  }

  return config as FeishuGlobalConfig
}

export function readBotWorkspaceDocuments(workspaceDir: string): FeishuBotDocuments {
  return {
    bot: readTextIfExists(path.join(workspaceDir, BOT_FILE_NAMES.bot)),
    personality: readTextIfExists(path.join(workspaceDir, BOT_FILE_NAMES.personality)),
    duties: readTextIfExists(path.join(workspaceDir, BOT_FILE_NAMES.duties)),
    skills: readTextIfExists(path.join(workspaceDir, BOT_FILE_NAMES.skills)),
    notes: readTextIfExists(path.join(workspaceDir, BOT_FILE_NAMES.notes)),
  }
}

export function resolveConfiguredBot(botName: string): LoadedFeishuBot {
  const config = readFeishuConfig()
  const botConfig = config.bots[botName]
  if (!botConfig) {
    throw new Error(`Feishu bot "${botName}" not found in ${ZDCODE_FEISHU_CONFIG_PATH}`)
  }
  if (!botConfig.enabled) {
    throw new Error(`Feishu bot "${botName}" is disabled`)
  }

  const workspaceDir = botConfig.workspaceDir?.trim()
    ? path.resolve(botConfig.workspaceDir)
    : resolveDefaultBotWorkspaceDir(botName)
  if (!fs.existsSync(workspaceDir) || !fs.statSync(workspaceDir).isDirectory()) {
    throw new Error(`Feishu bot "${botName}" workspaceDir does not exist: ${workspaceDir}`)
  }

  const logFile = botConfig.receive?.logFile?.trim()
    ? path.resolve(botConfig.receive.logFile)
    : resolveDefaultBotLogFile(botName)

  return {
    name: botName,
    config: {
      ...botConfig,
      workspaceDir,
      receive: {
        ...(botConfig.receive || {}),
        logFile,
      },
    },
    workspaceDir,
    documents: readBotWorkspaceDocuments(workspaceDir),
  }
}

export function resolveAllEnabledBots(): LoadedFeishuBot[] {
  const config = readFeishuConfig()
  return Object.keys(config.bots)
    .filter((botName) => config.bots[botName]?.enabled)
    .map((botName) => resolveConfiguredBot(botName))
}
