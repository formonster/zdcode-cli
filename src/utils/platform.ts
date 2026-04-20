import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

export type RuntimeHealth = {
  ok: boolean
  status?: string
  version?: string
  runtime?: {
    python?: string
    project?: string
    agentsAvailable?: boolean
    mem0Available?: boolean
    playwrightAvailable?: boolean
    openAIApiKey?: boolean
    defaultModel?: string
    modelCount?: number
  }
  database?: {
    path?: string
    exists?: boolean
  }
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const resolvePackageRoot = () => {
  const candidates = [process.cwd(), __dirname, path.resolve(__dirname, '..'), path.resolve(__dirname, '..', '..')]

  for (const start of candidates) {
    let current = path.resolve(start)
    while (true) {
      const manifest = path.join(current, 'package.json')
      if (fs.existsSync(manifest)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(manifest, 'utf-8'))
          if (parsed?.name === '@zdcode/cli') {
            return current
          }
        } catch {
          // Ignore invalid manifests while searching upward.
        }
      }

      const parent = path.dirname(current)
      if (parent === current) {
        break
      }
      current = parent
    }
  }

  return path.resolve(__dirname, '..', '..')
}

const PACKAGE_ROOT = resolvePackageRoot()

export const ZDCODE_PLATFORM_HOME = path.join(os.homedir(), '.zdcode', 'platform')
export const ZDCODE_PLATFORM_DB = path.join(ZDCODE_PLATFORM_HOME, 'zdcode-platform.db')
export const ZDCODE_PLATFORM_PID = path.join(ZDCODE_PLATFORM_HOME, 'runtime.pid')
export const ZDCODE_CHANNELS_BRIDGE_PID = path.join(ZDCODE_PLATFORM_HOME, 'channels-bridge.pid')
export const ZDCODE_PLATFORM_PORT = Number(process.env.ZDCODE_PLATFORM_PORT || 4141)
export const ZDCODE_PLATFORM_HOST = process.env.ZDCODE_PLATFORM_HOST || '127.0.0.1'

export const platformBaseUrl = (host: string = ZDCODE_PLATFORM_HOST, port: number = ZDCODE_PLATFORM_PORT) =>
  `http://${host}:${port}`

export const ensurePlatformDirs = () => {
  fs.mkdirSync(ZDCODE_PLATFORM_HOME, { recursive: true })
}

export const getPackageRoot = () => PACKAGE_ROOT

export const getDashboardDir = () => {
  const modernDashboard = path.join(PACKAGE_ROOT, 'dashboard', 'dist')
  if (fs.existsSync(modernDashboard)) {
    return modernDashboard
  }
  return path.join(PACKAGE_ROOT, 'dashboard')
}

export const getRuntimeAppPath = () => path.join(PACKAGE_ROOT, 'python_runtime', 'app.py')
export const getCliEntryPath = () => path.join(PACKAGE_ROOT, 'dist', 'index.js')

export const getOpenAIAgentsProject = () => {
  const configured = process.env.ZDCODE_OPENAI_AGENTS_PROJECT?.trim()
  if (configured) {
    return path.resolve(configured)
  }

  const sibling = path.resolve(PACKAGE_ROOT, '..', 'openai-agents-python')
  if (fs.existsSync(sibling)) {
    return sibling
  }

  return '/Users/ding/zdcode/openai-agents-python'
}

export const runtimeUvArgs = (extraArgs: string[] = []) => {
  const args = [
    'run',
    '--project',
    getOpenAIAgentsProject(),
    'python',
    getRuntimeAppPath(),
    ...extraArgs,
  ]

  return {
    command: '/opt/homebrew/bin/uv',
    args,
  }
}

export const openBrowser = (targetUrl: string) => {
  const platform = process.platform
  const command =
    platform === 'darwin'
      ? 'open'
      : platform === 'win32'
        ? 'start'
        : 'xdg-open'

  spawn(command, [targetUrl], {
    detached: true,
    stdio: 'ignore',
    shell: platform === 'win32',
  }).unref()
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const fetchJson = async <T>(input: string, init?: RequestInit) => {
  const response = await fetch(input, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  })

  const text = await response.text()
  const payload = text ? JSON.parse(text) : {}
  if (!response.ok) {
    throw new Error(payload?.detail || payload?.error || response.statusText)
  }
  return payload as T
}

export const tryFetchHealth = async (baseUrl: string) => {
  try {
    return await fetchJson<RuntimeHealth>(`${baseUrl}/health`)
  } catch {
    return null
  }
}

export const waitForRuntime = async (baseUrl: string, timeoutMs: number = 20_000) => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const health = await tryFetchHealth(baseUrl)
    if (health?.ok) {
      return health
    }
    await sleep(500)
  }

  throw new Error(`Runtime did not become healthy within ${timeoutMs}ms`)
}

export const startRuntimeDetached = (baseUrl: string) => {
  ensurePlatformDirs()
  const { command, args } = runtimeUvArgs([
    '--host',
    ZDCODE_PLATFORM_HOST,
    '--port',
    String(ZDCODE_PLATFORM_PORT),
  ])
  const child = spawn(command, args, {
    cwd: getPackageRoot(),
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ZDCODE_PLATFORM_DB,
      ZDCODE_DASHBOARD_DIR: getDashboardDir(),
    },
  })
  child.unref()
  fs.writeFileSync(ZDCODE_PLATFORM_PID, String(child.pid))
  return baseUrl
}

export const runtimeAlreadyHealthy = async (baseUrl: string) => {
  const health = await tryFetchHealth(baseUrl)
  return Boolean(health?.ok)
}

export const spawnRuntimeForeground = (host: string, port: number) => {
  const { command, args } = runtimeUvArgs(['--host', host, '--port', String(port)])
  const result = spawnSync(command, args, {
    cwd: getPackageRoot(),
    stdio: 'inherit',
    env: {
      ...process.env,
      ZDCODE_PLATFORM_DB,
      ZDCODE_DASHBOARD_DIR: getDashboardDir(),
    },
  })

  return result.status ?? 0
}

export const readPidIfExists = () => {
  if (!fs.existsSync(ZDCODE_PLATFORM_PID)) {
    return null
  }

  const raw = fs.readFileSync(ZDCODE_PLATFORM_PID, 'utf-8').trim()
  const pid = Number(raw)
  return Number.isFinite(pid) ? pid : null
}

const processAlive = (pid: number | null) => {
  if (!pid || !Number.isFinite(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const channelsBridgeAlreadyRunning = () => {
  if (!fs.existsSync(ZDCODE_CHANNELS_BRIDGE_PID)) {
    return false
  }
  const pid = Number(fs.readFileSync(ZDCODE_CHANNELS_BRIDGE_PID, 'utf-8').trim())
  return processAlive(pid)
}

export const startChannelsBridgeDetached = (baseUrl: string) => {
  ensurePlatformDirs()
  const child = spawn(process.execPath, [getCliEntryPath(), 'channels', 'bridge', '--runtime-url', baseUrl], {
    cwd: getPackageRoot(),
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ZDCODE_PLATFORM_DB,
      ZDCODE_DASHBOARD_DIR: getDashboardDir(),
    },
  })
  child.unref()
  fs.writeFileSync(ZDCODE_CHANNELS_BRIDGE_PID, String(child.pid))
  return child.pid
}

export const ensureRuntimeAvailable = async () => {
  const baseUrl = platformBaseUrl()
  if (!(await runtimeAlreadyHealthy(baseUrl))) {
    throw new Error(`Runtime is not running. Start it with "zdcode dashboard" or "zdcode runtime serve".`)
  }
  return baseUrl
}
