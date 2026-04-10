import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const requests = []

const readJsonBody = async (req) => {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8') || '{}'
  return JSON.parse(text)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const body = await readJsonBody(req)
  requests.push({
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    headers: req.headers,
    body,
  })

  if (url.pathname === '/open-apis/auth/v3/tenant_access_token/internal') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 0, tenant_access_token: 'tenant-token' }))
    return
  }

  if (url.pathname === '/open-apis/im/v1/messages') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 0, data: { message_id: 'om_mock_123' } }))
    return
  }

  if (url.pathname === '/webhook') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ StatusCode: 0, StatusMessage: 'success' }))
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ code: 404, msg: 'not found' }))
})

server.listen(0, '127.0.0.1')
await once(server, 'listening')

const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
const domain = `http://127.0.0.1:${port}`
const webhook = `${domain}/webhook`
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zdcode-feishu-home-'))
process.env.HOME = tempHome
const configDir = path.join(tempHome, '.zdcode', 'feishu')
const configPath = path.join(configDir, 'config.json')

const runCli = (args, extraEnv = {}) =>
  new Promise((resolve) => {
    const child = spawn('node', ['./dist/index.js', ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tempHome,
        FEISHU_APP_ID: '',
        FEISHU_APP_SECRET: '',
        FEISHU_WEBHOOK: '',
        FEISHU_DOMAIN: '',
        ...extraEnv,
      },
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
    child.on('close', (code) => {
      resolve({ code, stdout, stderr })
    })
  })

try {
  let result = await runCli(['feishu', 'init'])
  assert.equal(result.code, 0, result.stderr)
  assert.ok(fs.existsSync(configPath))
  assert.ok(fs.existsSync(path.join(configDir, 'bots', 'default', 'BOT.md')))
  assert.ok(fs.existsSync(path.join(configDir, 'bots', 'default', 'PERSONALITY.md')))
  let config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  assert.equal(config.bots.default.codex.enabled, true)
  assert.equal(config.bots.default.codex.replyMode, 'stream_progress')
  assert.equal(config.bots.default.codex.fullAuto, true)
  assert.equal(config.bots.default.workspaceDir, undefined)
  assert.equal(config.bots.default.receive, undefined)

  result = await runCli(['feishu', 'create-bot', '--name', '白豆腐', '--allow-chat-id', 'oc_group_2'])
  assert.equal(result.code, 0, result.stderr)

  config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  assert.ok(config.bots['白豆腐'])
  assert.equal(config.bots['白豆腐'].routing.allowChatIds[0], 'oc_group_2')
  assert.equal(config.bots['白豆腐'].codex.replyMode, 'stream_progress')
  assert.equal(config.bots['白豆腐'].workspaceDir, undefined)
  assert.equal(config.bots['白豆腐'].receive, undefined)
  assert.ok(fs.existsSync(path.join(configDir, 'bots', '白豆腐', 'BOT.md')))

  config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  config.bots.default.appId = 'cli_default'
  config.bots.default.appSecret = 'secret_default'
  config.bots.default.domain = domain
  config.bots.groupbot = {
    enabled: true,
    appId: '',
    appSecret: '',
    domain: domain,
    webhook,
    routing: {
      allowChatIds: ['oc_group_1'],
    },
  }
  const groupbotDir = path.join(configDir, 'bots', 'groupbot')
  fs.mkdirSync(groupbotDir, { recursive: true })
  fs.writeFileSync(path.join(groupbotDir, 'BOT.md'), '# groupbot\n')
  fs.writeFileSync(path.join(groupbotDir, 'PERSONALITY.md'), '# personality\n')
  fs.writeFileSync(path.join(groupbotDir, 'DUTIES.md'), '# duties\n')
  fs.writeFileSync(path.join(groupbotDir, 'SKILLS.md'), '# skills\n')
  fs.writeFileSync(path.join(groupbotDir, 'NOTES.md'), '# notes\n')
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

  result = await runCli(
    ['feishu', 'send', '--bot', 'default', '--target', 'ou_user_1', '--message', 'hello', '--json'],
  )
  assert.equal(result.code, 0, result.stderr)
  let parsed = JSON.parse(result.stdout)
  assert.equal(parsed.bot, 'default')
  assert.equal(parsed.mode, 'api')
  assert.equal(parsed.receiveIdType, 'open_id')
  assert.equal(parsed.messageId, 'om_mock_123')

  result = await runCli(
    ['feishu', 'send', '--bot', 'groupbot', '--target', 'chat:oc_group_1', '--message', 'group notice', '--json'],
  )
  assert.equal(result.code, 0, result.stderr)
  parsed = JSON.parse(result.stdout)
  assert.equal(parsed.bot, 'groupbot')
  assert.equal(parsed.mode, 'webhook')
  assert.equal(parsed.webhookUsed, true)

  result = await runCli(
    ['feishu', 'send', '--target', 'user:john_doe', '--message', 'hello'],
  )
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /required option '--bot <name>' not specified/i)

  result = await runCli(
    ['feishu', 'send', '--bot', 'missing', '--target', 'ou_user_2', '--message', 'hello'],
  )
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /not found/i)

  const apiMessageRequest = requests.find((item) => item.path === '/open-apis/im/v1/messages')
  assert.ok(apiMessageRequest)
  assert.equal(apiMessageRequest.query.receive_id_type, 'open_id')
  assert.equal(apiMessageRequest.body.receive_id, 'ou_user_1')

  const webhookRequest = requests.find((item) => item.path === '/webhook')
  assert.ok(webhookRequest)
  assert.equal(webhookRequest.body.content.text, 'group notice')

  const mockCodexLog = path.join(tempHome, 'mock-codex-log.jsonl')
  const mockCodexPath = path.join(tempHome, 'mock-codex')
  fs.writeFileSync(
    mockCodexPath,
    `#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const args = process.argv.slice(2)
const outputIndex = args.findIndex((item) => item === '-o' || item === '--output-last-message')
const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : ''
const isResume = args[0] === 'exec' && args[1] === 'resume'
const sessionId = isResume ? args[2] : '11111111-1111-4111-8111-111111111111'
const prompt = isResume ? args[3] : args[1]
const reply = prompt.includes('第二轮') ? '第二轮回复' : '第一轮回复'
if (outputFile) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true })
  fs.writeFileSync(outputFile, reply + '\\n', 'utf8')
}
if (process.env.MOCK_CODEX_LOG) {
  fs.appendFileSync(
    process.env.MOCK_CODEX_LOG,
    JSON.stringify({ args, isResume, sessionId, prompt, outputFile }) + '\\n',
    'utf8',
  )
}
process.stdout.write(JSON.stringify({ type: isResume ? 'session.resumed' : 'session.started', session_id: sessionId }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'message', role: 'assistant', text: reply }) + '\\n')
`,
    'utf8',
  )
  fs.chmodSync(mockCodexPath, 0o755)

  const testModule = await import(pathToFileURL(path.join(process.cwd(), 'dist/test-feishu.js')).href)

  process.env.ZDCODE_CODEX_BIN = mockCodexPath
  process.env.MOCK_CODEX_LOG = mockCodexLog

  config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  config.bots.default.codex = {
    enabled: true,
    replyMode: 'stream_progress',
    fullAuto: true,
    extraArgs: ['--mock-flag'],
  }
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

  const bot = testModule.resolveConfiguredBot('default')
  const beforeBridge = requests.length

  await testModule.handleFeishuCodexBridge({
    bot,
    message: {
      chatId: 'oc_bridge_chat',
      chatType: 'p2p',
      messageId: 'om_bridge_1',
      senderId: 'ou_sender_1',
      text: '第一轮',
      timestamp: '2026-04-10T12:00:00.000Z',
    },
    appId: 'cli_default',
    appSecret: 'secret_default',
    domain,
    logger: () => {},
  })

  await testModule.handleFeishuCodexBridge({
    bot: testModule.resolveConfiguredBot('default'),
    message: {
      chatId: 'oc_bridge_chat',
      chatType: 'p2p',
      messageId: 'om_bridge_2',
      senderId: 'ou_sender_1',
      text: '第二轮',
      timestamp: '2026-04-10T12:01:00.000Z',
    },
    appId: 'cli_default',
    appSecret: 'secret_default',
    domain,
    logger: () => {},
  })

  const ledgerPath = path.join(configDir, 'bots', 'default', 'sessions.json')
  assert.ok(fs.existsSync(ledgerPath))
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
  assert.equal(ledger.sessions.oc_bridge_chat.codexSessionId, '11111111-1111-4111-8111-111111111111')
  assert.equal(ledger.sessions.oc_bridge_chat.lastMessageId, 'om_bridge_2')
  assert.equal(ledger.sessions.oc_bridge_chat.transcript.at(-1).text, '第二轮回复')

  const runFiles = fs.readdirSync(path.join(configDir, 'bots', 'default', 'runs')).filter((file) => file.endsWith('.json'))
  assert.ok(runFiles.length >= 2)

  const mockInvocations = fs
    .readFileSync(mockCodexLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.equal(mockInvocations.length, 2)
  assert.equal(mockInvocations[0].isResume, false)
  assert.equal(mockInvocations[1].isResume, true)
  assert.ok(mockInvocations[0].args.includes('--full-auto'))
  assert.ok(mockInvocations[0].args.includes('--mock-flag'))

  const bridgeRequests = requests.slice(beforeBridge).filter((item) => item.path === '/open-apis/im/v1/messages')
  assert.equal(bridgeRequests.length, 6)
  assert.equal(JSON.parse(bridgeRequests[2].body.content).text, '第一轮回复')
  assert.equal(JSON.parse(bridgeRequests[5].body.content).text, '第二轮回复')

  const settings = testModule.resolveBotCodexSettings({
    enabled: true,
    appId: 'x',
    appSecret: 'y',
  })
  assert.equal(settings.replyMode, 'stream_progress')
  assert.equal(settings.fullAuto, true)

  const prompt = testModule.buildCodexPrompt({
    bot,
    message: {
      chatId: 'oc_prompt',
      chatType: 'p2p',
      messageId: 'om_prompt',
      senderId: 'ou_prompt',
      text: '请介绍一下你自己',
      timestamp: '2026-04-10T12:02:00.000Z',
    },
    session: {
      createdAt: '2026-04-10T12:00:00.000Z',
      updatedAt: '2026-04-10T12:00:00.000Z',
      transcript: [{ role: 'user', text: '上一条消息', at: '2026-04-10T11:59:00.000Z' }],
    },
  })
  assert.match(prompt, /Bot Identity/)
  assert.match(prompt, /Previous Conversation/)
  assert.match(prompt, /请介绍一下你自己/)

  console.log('feishu multi-bot CLI tests passed')
} finally {
  server.close()
}
