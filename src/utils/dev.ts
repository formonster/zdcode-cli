import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'

export type DevConfig = {
  projectName: string
  worktreeRoot: string
  baseBranch: string
  codexCommand: string
}

export type SessionMeta = {
  sessionName: string
  projectRoot: string
  worktreePath: string
  branch: string
  task: string
  taskSlug: string
  logPath: string
  createdAt: string
}

export const ZDCODE_HOME = path.join(os.homedir(), '.zdcode')
export const ZDCODE_CONFIG_DIR = path.join(ZDCODE_HOME, 'config')
export const ZDCODE_LOG_DIR = path.join(ZDCODE_HOME, 'logs')
export const ZDCODE_RUNNER_DIR = path.join(ZDCODE_HOME, 'runners')
export const SESSION_STORE = path.join(ZDCODE_HOME, 'sessions.json')

export const ensureDir = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true })
}

export const ensureGlobalDirs = () => {
  ensureDir(ZDCODE_HOME)
  ensureDir(ZDCODE_CONFIG_DIR)
  ensureDir(ZDCODE_LOG_DIR)
  ensureDir(ZDCODE_RUNNER_DIR)
}

export const slugify = (input: string, maxLen: number = 24) =>
  input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen) || 'task'

export const shortHash = (input: string, len: number = 6) => {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36).slice(0, len)
}

export const nowStamp = () => {
  const now = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

export const run = (command: string, cwd?: string) =>
  execSync(command, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  }).trim()

export const safeRun = (command: string, cwd?: string) => {
  try {
    return run(command, cwd)
  } catch {
    return ''
  }
}

export const isGitRepo = (cwd: string) => {
  const out = safeRun('git rev-parse --show-toplevel', cwd)
  return Boolean(out)
}

export const getGitRoot = (cwd: string) => run('git rev-parse --show-toplevel', cwd)

export const getCurrentBranch = (cwd: string) => {
  const branch = safeRun('git rev-parse --abbrev-ref HEAD', cwd)
  return branch || 'main'
}

export const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

export const readProjectConfig = (projectRoot: string): DevConfig | null => {
  const file = path.join(projectRoot, '.zdcode', 'dev.json')
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as DevConfig
}

export const writeProjectConfig = (projectRoot: string, config: DevConfig) => {
  const dir = path.join(projectRoot, '.zdcode')
  ensureDir(dir)
  fs.writeFileSync(path.join(dir, 'dev.json'), `${JSON.stringify(config, null, 2)}\n`)
}

export const defaultConfig = (projectRoot: string): DevConfig => {
  const projectName = path.basename(projectRoot)
  return {
    projectName,
    worktreeRoot: path.join(projectRoot, '.worktrees'),
    baseBranch: getCurrentBranch(projectRoot) || 'main',
    codexCommand: 'codex exec --full-auto',
  }
}


export const ensureGitignoreEntry = (projectRoot: string, entry: string) => {
  const gitignorePath = path.join(projectRoot, '.gitignore')
  const normalized = entry.trim()

  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, `${normalized}\n`)
    return true
  }

  const content = fs.readFileSync(gitignorePath, 'utf-8')
  const lines = content.split(/\r?\n/).map((line) => line.trim())
  if (lines.includes(normalized) || lines.includes(normalized.replace(/\/$/, ''))) {
    return false
  }

  const next = content.endsWith('\n') || content.length === 0
    ? `${content}${normalized}\n`
    : `${content}\n${normalized}\n`
  fs.writeFileSync(gitignorePath, next)
  return true
}

export const readSessions = (): SessionMeta[] => {
  if (!fs.existsSync(SESSION_STORE)) return []
  try {
    return JSON.parse(fs.readFileSync(SESSION_STORE, 'utf-8')) as SessionMeta[]
  } catch {
    return []
  }
}

export const writeSessions = (sessions: SessionMeta[]) => {
  ensureGlobalDirs()
  fs.writeFileSync(SESSION_STORE, `${JSON.stringify(sessions, null, 2)}\n`)
}

export const upsertSession = (session: SessionMeta) => {
  const all = readSessions().filter((item) => item.sessionName !== session.sessionName)
  all.unshift(session)
  writeSessions(all)
}

export const sessionRunning = (sessionName: string) => {
  const cmd = `tmux has-session -t ${quote(sessionName)} 2>/dev/null && echo yes || echo no`
  return safeRun(cmd) === 'yes'
}
