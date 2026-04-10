import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import {
  FeishuBotConfig,
  LoadedFeishuBot,
  resolveBotRunsDir,
  resolveBotSessionsFile,
} from './config'
import { sendFeishuMessage } from './send'

export type FeishuCodexReplyMode = 'final_only' | 'final_and_log' | 'stream_progress'

export type ParsedFeishuIncomingMessage = {
  chatId: string
  chatType: string
  messageId: string
  senderId: string
  text: string
  timestamp: string
  rawEvent?: unknown
}

export type CodexSessionTranscriptEntry = {
  role: 'user' | 'assistant'
  text: string
  at: string
  messageId?: string
}

export type CodexSessionRecord = {
  codexSessionId?: string
  createdAt: string
  updatedAt: string
  lastMessageId?: string
  transcript?: CodexSessionTranscriptEntry[]
}

export type CodexSessionsLedger = {
  version: 1
  sessions: Record<string, CodexSessionRecord>
}

export type FeishuCodexSettings = {
  enabled: boolean
  replyMode: FeishuCodexReplyMode
  fullAuto: boolean
  extraArgs: string[]
}

export type CodexRunResult = {
  sessionId?: string
  finalReply: string
  stdout: string
  stderr: string
  prompt: string
  outputFile: string
  runFile: string
  resumed: boolean
  fallbackUsed: boolean
  command: string[]
  progressUpdates: string[]
  events: unknown[]
}

type RunCodexForChatInput = {
  bot: LoadedFeishuBot
  message: ParsedFeishuIncomingMessage
  session: CodexSessionRecord
}

type ExecuteCodexInput = {
  workspaceDir: string
  prompt: string
  outputFile: string
  existingSessionId?: string
  settings: FeishuCodexSettings
}

const CODEX_SESSIONS_VERSION = 1 as const
const MAX_TRANSCRIPT_ENTRIES = 12
const UUID_REGEX =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i

const ensureDir = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true })
}

const readTextIfExists = (filePath: string) => {
  if (!fs.existsSync(filePath)) {
    return ''
  }
  return fs.readFileSync(filePath, 'utf-8')
}

const formatSection = (title: string, body: string) =>
  [`## ${title}`, body.trim() || '(empty)', ''].join('\n')

const createPromptTranscript = (transcript: CodexSessionTranscriptEntry[] = []) => {
  if (!transcript.length) {
    return '## Previous Conversation\n(none)\n'
  }

  const lines = transcript.slice(-MAX_TRANSCRIPT_ENTRIES).map((entry) => {
    const label = entry.role === 'user' ? 'User' : 'Assistant'
    return `[${entry.at}] ${label}: ${entry.text}`
  })

  return `## Previous Conversation\n${lines.join('\n')}\n`
}

const parseJsonLines = (stdout: string) => {
  const events: unknown[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      continue
    }
  }
  return events
}

const scanForSessionId = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const match = value.match(UUID_REGEX)
    return match?.[0]
  }

  if (!value || typeof value !== 'object') {
    return undefined
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = scanForSessionId(item)
      if (found) return found
    }
    return undefined
  }

  const objectValue = value as Record<string, unknown>
  const directKeys = ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'threadId']
  for (const key of directKeys) {
    const directValue = objectValue[key]
    if (typeof directValue === 'string') {
      return directValue
    }
  }

  for (const nestedValue of Object.values(objectValue)) {
    const found = scanForSessionId(nestedValue)
    if (found) return found
  }

  return undefined
}

const resolveCodexBinary = () => process.env.ZDCODE_CODEX_BIN?.trim() || 'codex'

export function resolveBotCodexSettings(config: FeishuBotConfig): FeishuCodexSettings {
  const codexConfig = config.codex
  const rawExtraArgs = codexConfig?.extraArgs
  const extraArgs = Array.isArray(rawExtraArgs) ? rawExtraArgs.filter(Boolean) : []

  return {
    enabled: codexConfig?.enabled ?? true,
    replyMode: codexConfig?.replyMode ?? 'stream_progress',
    fullAuto: codexConfig?.fullAuto ?? true,
    extraArgs,
  }
}

export function readCodexSessionsLedger(workspaceDir: string): CodexSessionsLedger {
  const filePath = resolveBotSessionsFile(workspaceDir)
  if (!fs.existsSync(filePath)) {
    return {
      version: CODEX_SESSIONS_VERSION,
      sessions: {},
    }
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<CodexSessionsLedger>
    if (parsed.version !== CODEX_SESSIONS_VERSION || !parsed.sessions || typeof parsed.sessions !== 'object') {
      throw new Error('invalid ledger shape')
    }
    return {
      version: CODEX_SESSIONS_VERSION,
      sessions: parsed.sessions,
    }
  } catch {
    throw new Error(`Invalid Codex sessions ledger: ${filePath}`)
  }
}

export function writeCodexSessionsLedger(workspaceDir: string, ledger: CodexSessionsLedger) {
  const filePath = resolveBotSessionsFile(workspaceDir)
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf-8')
}

export function buildCodexPrompt(params: {
  bot: LoadedFeishuBot
  message: ParsedFeishuIncomingMessage
  session?: CodexSessionRecord
}) {
  const { bot, message, session } = params
  return [
    '# Feishu Bot Runtime',
    '',
    'You are replying as a Feishu bot bridged to local Codex.',
    'Stay in character and follow the workspace instructions below.',
    '',
    formatSection('Bot Identity', bot.documents.bot),
    formatSection('Personality', bot.documents.personality),
    formatSection('Duties', bot.documents.duties),
    formatSection('Skills', bot.documents.skills),
    formatSection('Notes', bot.documents.notes),
    '## Runtime Metadata',
    `- botName: ${bot.name}`,
    `- workspaceDir: ${bot.workspaceDir}`,
    `- chatId: ${message.chatId}`,
    `- chatType: ${message.chatType}`,
    `- senderId: ${message.senderId}`,
    `- messageId: ${message.messageId}`,
    `- timestamp: ${message.timestamp}`,
    '',
    createPromptTranscript(session?.transcript),
    '## Latest User Message',
    message.text,
    '',
    'Reply in plain text suitable for directly sending back to the same Feishu chat.',
  ].join('\n')
}

const resolveProgressUpdates = (message: ParsedFeishuIncomingMessage, resumed: boolean) => {
  const intro = resumed ? '继续当前会话，正在处理你的消息。' : '收到消息，正在创建会话并处理。'
  return [intro, `当前会话：${message.chatId}`]
}

const executeCodex = async (input: ExecuteCodexInput) => {
  const codexBinary = resolveCodexBinary()
  const command = input.existingSessionId
    ? ['exec', 'resume', input.existingSessionId, input.prompt]
    : ['exec', input.prompt, '--cd', input.workspaceDir]

  if (input.settings.fullAuto) {
    command.push('--full-auto')
  }
  command.push('--skip-git-repo-check', '--json', '-o', input.outputFile, ...input.settings.extraArgs)

  return await new Promise<{
    code: number | null
    stdout: string
    stderr: string
    command: string[]
  }>((resolve, reject) => {
    const child = spawn(codexBinary, command, {
      cwd: input.workspaceDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({
        code,
        stdout,
        stderr,
        command: [codexBinary, ...command],
      })
    })
  })
}

export async function runCodexForChat(input: RunCodexForChatInput): Promise<CodexRunResult> {
  const settings = resolveBotCodexSettings(input.bot.config)
  const prompt = buildCodexPrompt(input)
  const runsDir = resolveBotRunsDir(input.bot.workspaceDir)
  ensureDir(runsDir)

  const fileSafeMessageId = input.message.messageId.replace(/[^\w.-]+/g, '-')
  const runBaseName = `${Date.now()}-${fileSafeMessageId}`
  const outputFile = path.join(runsDir, `${runBaseName}.reply.txt`)
  const runFile = path.join(runsDir, `${runBaseName}.json`)

  let resumed = Boolean(input.session.codexSessionId)
  let fallbackUsed = false
  let execution = await executeCodex({
    workspaceDir: input.bot.workspaceDir,
    prompt,
    outputFile,
    existingSessionId: input.session.codexSessionId,
    settings,
  })

  if (execution.code !== 0 && input.session.codexSessionId) {
    fallbackUsed = true
    resumed = false
    execution = await executeCodex({
      workspaceDir: input.bot.workspaceDir,
      prompt,
      outputFile,
      settings,
    })
  }

  if (execution.code !== 0) {
    throw new Error(`Codex command failed with exit code ${execution.code ?? 'unknown'}: ${execution.stderr || execution.stdout}`)
  }

  const events = parseJsonLines(execution.stdout)
  const sessionId =
    scanForSessionId(events) ||
    scanForSessionId(execution.stdout) ||
    input.session.codexSessionId

  const finalReply = readTextIfExists(outputFile).trim()
  const result: CodexRunResult = {
    sessionId,
    finalReply: finalReply || 'Codex completed without a final reply.',
    stdout: execution.stdout,
    stderr: execution.stderr,
    prompt,
    outputFile,
    runFile,
    resumed,
    fallbackUsed,
    command: execution.command,
    progressUpdates: resolveProgressUpdates(input.message, resumed),
    events,
  }

  return result
}

export function persistRunArtifacts(params: {
  bot: LoadedFeishuBot
  message: ParsedFeishuIncomingMessage
  sessionRecord: CodexSessionRecord
  result?: CodexRunResult
  error?: unknown
}) {
  const runsDir = resolveBotRunsDir(params.bot.workspaceDir)
  ensureDir(runsDir)

  const fileSafeMessageId = params.message.messageId.replace(/[^\w.-]+/g, '-')
  const runFile =
    params.result?.runFile || path.join(runsDir, `${Date.now()}-${fileSafeMessageId}.json`)

  const payload = {
    bot: params.bot.name,
    workspaceDir: params.bot.workspaceDir,
    message: params.message,
    session: params.sessionRecord,
    result: params.result
      ? {
          sessionId: params.result.sessionId,
          finalReply: params.result.finalReply,
          resumed: params.result.resumed,
          fallbackUsed: params.result.fallbackUsed,
          outputFile: params.result.outputFile,
          command: params.result.command,
          progressUpdates: params.result.progressUpdates,
          stdout: params.result.stdout,
          stderr: params.result.stderr,
          events: params.result.events,
          prompt: params.result.prompt,
        }
      : undefined,
    error: params.error instanceof Error ? params.error.message : params.error ? String(params.error) : undefined,
    createdAt: new Date().toISOString(),
  }

  fs.writeFileSync(runFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
  return runFile
}

const trimReplyForFeishu = (text: string) => {
  const trimmed = text.trim()
  if (!trimmed) {
    return '已处理完成，但没有生成可发送的文本回复。'
  }
  return trimmed
}

const composeFinalReply = (replyMode: FeishuCodexReplyMode, finalReply: string, runFile: string) => {
  if (replyMode === 'final_and_log') {
    return `${trimReplyForFeishu(finalReply)}\n\n[local run log]\n${runFile}`
  }
  return trimReplyForFeishu(finalReply)
}

export async function handleFeishuCodexBridge(params: {
  bot: LoadedFeishuBot
  message: ParsedFeishuIncomingMessage
  appId: string
  appSecret: string
  domain: string
  logger: (line: string) => void
}) {
  const settings = resolveBotCodexSettings(params.bot.config)
  if (!settings.enabled) {
    params.logger(`[${new Date().toISOString()}] bot=${params.bot.name} codex bridge disabled`)
    return
  }

  const ledger = readCodexSessionsLedger(params.bot.workspaceDir)
  const existing = ledger.sessions[params.message.chatId]
  const now = new Date().toISOString()
  const sessionRecord: CodexSessionRecord = existing || {
    createdAt: now,
    updatedAt: now,
    transcript: [],
  }

  const appendedTranscript = [
    ...(sessionRecord.transcript || []),
    {
      role: 'user' as const,
      text: params.message.text,
      at: params.message.timestamp,
      messageId: params.message.messageId,
    },
  ].slice(-MAX_TRANSCRIPT_ENTRIES)

  sessionRecord.updatedAt = now
  sessionRecord.lastMessageId = params.message.messageId
  sessionRecord.transcript = appendedTranscript

  if (settings.replyMode === 'stream_progress') {
    for (const progress of resolveProgressUpdates(params.message, Boolean(sessionRecord.codexSessionId))) {
      await sendFeishuMessage({
        target: `chat:${params.message.chatId}`,
        message: progress,
        mode: 'api',
        appId: params.appId,
        appSecret: params.appSecret,
        domain: params.domain,
        receiveIdType: 'chat_id',
      })
    }
  }

  try {
    const result = await runCodexForChat({
      bot: params.bot,
      message: params.message,
      session: sessionRecord,
    })

    sessionRecord.updatedAt = new Date().toISOString()
    sessionRecord.codexSessionId = result.sessionId || sessionRecord.codexSessionId
    sessionRecord.transcript = [
      ...(sessionRecord.transcript || []),
      {
        role: 'assistant' as const,
        text: result.finalReply,
        at: sessionRecord.updatedAt,
      },
    ].slice(-MAX_TRANSCRIPT_ENTRIES)

    ledger.sessions[params.message.chatId] = sessionRecord
    writeCodexSessionsLedger(params.bot.workspaceDir, ledger)
    const runFile = persistRunArtifacts({
      bot: params.bot,
      message: params.message,
      sessionRecord,
      result,
    })

    const replyText = composeFinalReply(settings.replyMode, result.finalReply, runFile)
    await sendFeishuMessage({
      target: `chat:${params.message.chatId}`,
      message: replyText,
      mode: 'api',
      appId: params.appId,
      appSecret: params.appSecret,
      domain: params.domain,
      receiveIdType: 'chat_id',
    })

    params.logger(
      `[${new Date().toISOString()}] bot=${params.bot.name} codex reply sent chat=${params.message.chatId} session=${sessionRecord.codexSessionId || 'unknown'}`,
    )
  } catch (error) {
    ledger.sessions[params.message.chatId] = sessionRecord
    writeCodexSessionsLedger(params.bot.workspaceDir, ledger)
    const runFile = persistRunArtifacts({
      bot: params.bot,
      message: params.message,
      sessionRecord,
      error,
    })

    const errorMessage = error instanceof Error ? error.message : String(error)
    await sendFeishuMessage({
      target: `chat:${params.message.chatId}`,
      message: `处理消息时出错了。\n\n${errorMessage}\n\n[local run log]\n${runFile}`,
      mode: 'api',
      appId: params.appId,
      appSecret: params.appSecret,
      domain: params.domain,
      receiveIdType: 'chat_id',
    })

    throw error
  }
}

export const __internal = {
  parseJsonLines,
  scanForSessionId,
  resolveCodexBinary,
  composeFinalReply,
  createPromptTranscript,
}
