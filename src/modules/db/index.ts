import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { Command } from 'commander'
import { getZdcodeHome } from '../../utils/platform'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8090
const DEFAULT_EMAIL = 'admin@zdcode.local'
const DEFAULT_PASSWORD = 'zdCode0110.'
/** GitHub API 有限流，优先通过 releases/latest 跳转解析版本，失败时回退到该版本 */
const FALLBACK_VERSION = '0.40.5'
const START_TIMEOUT = 15000

type DbOptions = {
  dir?: string
  host?: string
  port?: string
  email?: string
  password?: string
}

type DbConfig = {
  version?: string
  host: string
  port: number
  email: string
}

const dbDir = (custom?: string) => path.resolve(custom || process.env.ZDCODE_DB_DIR || path.join(getZdcodeHome(), 'db'))

const paths = (dir: string) => ({
  dir,
  binary: path.join(dir, 'pocketbase'),
  data: path.join(dir, 'pb_data'),
  log: path.join(dir, 'pocketbase.log'),
  pid: path.join(dir, 'pocketbase.pid'),
  config: path.join(dir, 'config.json'),
})

const readConfig = (dir: string, options: DbOptions = {}): DbConfig => {
  const configPath = paths(dir).config
  let saved: Partial<DbConfig> = {}
  if (fs.existsSync(configPath)) {
    try {
      saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    } catch {
      saved = {}
    }
  }
  return {
    version: saved.version,
    host: options.host || saved.host || DEFAULT_HOST,
    port: Number(options.port || saved.port || DEFAULT_PORT),
    email: options.email || saved.email || DEFAULT_EMAIL,
  }
}

const writeConfig = (dir: string, config: DbConfig) => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(paths(dir).config, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
}

const platformName = () => {
  if (process.platform === 'darwin') return 'darwin'
  if (process.platform === 'linux') return 'linux'
  if (process.platform === 'win32') return 'windows'
  throw new Error(`不支持的平台：${process.platform}`)
}

const archName = () => {
  if (process.arch === 'arm64') return 'arm64'
  if (process.arch === 'x64') return 'amd64'
  throw new Error(`不支持的架构：${process.arch}`)
}

const fetchWithTimeout = async (url: string, timeout: number) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(url, { signal: controller.signal, redirect: 'follow' })
  } finally {
    clearTimeout(timer)
  }
}

const resolveVersion = async () => {
  try {
    const response = await fetchWithTimeout('https://github.com/pocketbase/pocketbase/releases/latest', 10000)
    const match = response.url.match(/\/tag\/v?([\d.]+)/)
    if (match) return match[1]
  } catch {
    // 网络不可用时回退到固定版本
  }
  return FALLBACK_VERSION
}

const unzip = (zipPath: string, targetDir: string) => {
  fs.mkdirSync(targetDir, { recursive: true })
  const result = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${targetDir}'`], { stdio: 'inherit' })
    : spawnSync('unzip', ['-o', zipPath, '-d', targetDir], { stdio: 'inherit' })
  if (result.error) throw new Error(`解压失败：${result.error.message}`)
  if (result.status !== 0) throw new Error(`解压失败，退出码 ${result.status}`)
}

/** 下载 PocketBase 可执行文件到数据目录，已存在则直接复用 */
const ensureBinary = async (dir: string, version?: string) => {
  const target = paths(dir)
  if (fs.existsSync(target.binary)) return target.binary

  const resolved = version || (await resolveVersion())
  const asset = `pocketbase_${resolved}_${platformName()}_${archName()}.zip`
  const url = `https://github.com/pocketbase/pocketbase/releases/download/v${resolved}/${asset}`

  fs.mkdirSync(dir, { recursive: true })
  console.log(`⬇️  正在下载 PocketBase v${resolved}：${url}`)

  const response = await fetchWithTimeout(url, 120000)
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)

  const buffer = Buffer.from(await response.arrayBuffer())
  const zipPath = path.join(dir, `${asset}.download`)
  const extractDir = path.join(dir, '.extract')
  fs.writeFileSync(zipPath, buffer)

  try {
    fs.rmSync(extractDir, { recursive: true, force: true })
    unzip(zipPath, extractDir)
    const extracted = path.join(extractDir, process.platform === 'win32' ? 'pocketbase.exe' : 'pocketbase')
    if (!fs.existsSync(extracted)) throw new Error('压缩包中未找到 pocketbase 可执行文件')
    fs.copyFileSync(extracted, target.binary)
    if (process.platform !== 'win32') fs.chmodSync(target.binary, 0o755)
  } finally {
    fs.rmSync(zipPath, { force: true })
    fs.rmSync(extractDir, { recursive: true, force: true })
  }

  const config = readConfig(dir)
  writeConfig(dir, { ...config, version: resolved })
  console.log(`✅ PocketBase 已安装：${target.binary}`)
  return target.binary
}

/** 创建或更新超级管理员账号（upsert 保证重复执行安全） */
const upsertSuperuser = (dir: string, email: string, password: string) => {
  const target = paths(dir)
  const result = spawnSync(target.binary, ['superuser', 'upsert', email, password, '--dir', target.data], {
    stdio: 'inherit',
  })
  if (result.error) throw new Error(`创建管理员失败：${result.error.message}`)
  if (result.status !== 0) throw new Error(`创建管理员失败，退出码 ${result.status}`)
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const readPid = (dir: string) => {
  const pidPath = paths(dir).pid
  if (!fs.existsSync(pidPath)) return undefined
  const pid = Number(fs.readFileSync(pidPath, 'utf-8').trim())
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

const healthUrl = (config: DbConfig) => `http://${config.host}:${config.port}/api/health`

const adminUrl = (config: DbConfig) => {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host
  return `http://${host}:${config.port}/_/`
}

const openBrowser = (url: string) => {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.unref()
}

const isServing = async (config: DbConfig) => {
  try {
    const response = await fetchWithTimeout(healthUrl(config), 2000)
    return response.ok
  } catch {
    return false
  }
}

const waitForServer = async (config: DbConfig) => {
  const deadline = Date.now() + START_TIMEOUT
  while (Date.now() < deadline) {
    if (await isServing(config)) return true
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return false
}

const tailLog = (dir: string, lines = 20) => {
  const logPath = paths(dir).log
  if (!fs.existsSync(logPath)) return ''
  const content = fs.readFileSync(logPath, 'utf-8').trimEnd().split(/\r?\n/)
  return content.slice(-lines).join('\n')
}

const dbInit = async (options: DbOptions) => {
  const dir = dbDir(options.dir)
  const binary = await ensureBinary(dir, readConfig(dir, options).version)
  // ensureBinary 可能刚写入版本号，这里重新读取
  const config = readConfig(dir, options)

  fs.mkdirSync(paths(dir).data, { recursive: true })
  const password = options.password || DEFAULT_PASSWORD

  console.log(`🔧 初始化管理员账号：${config.email}`)
  upsertSuperuser(dir, config.email, password)
  writeConfig(dir, config)

  console.log('✅ 数据库初始化完成')
  console.log(`- 数据目录：${paths(dir).data}`)
  console.log(`- 可执行文件：${binary}`)
  console.log(`- 管理员账号：${config.email}`)
  console.log(`- 管理员密码：${password}`)
  console.log(`- 启动命令：zdcode db start${options.dir ? ` --dir ${dir}` : ''}`)
}

const dbStart = async (options: DbOptions) => {
  const dir = dbDir(options.dir)
  const config = readConfig(dir, options)

  if (await isServing(config)) {
    console.log(`✅ 数据库已在运行：http://${config.host}:${config.port}`)
    return
  }

  if (!fs.existsSync(paths(dir).data)) {
    throw new Error(`数据目录不存在，请先执行：zdcode db init${options.dir ? ` --dir ${dir}` : ''}`)
  }

  const binary = await ensureBinary(dir, config.version)
  // 记录本次实际使用的监听地址，后续 status / stop 复用
  writeConfig(dir, config)
  // 进程仍在但健康检查未通过时，等待其就绪，避免重复拉起
  const existingPid = readPid(dir)
  if (existingPid && isAlive(existingPid)) {
    if (await waitForServer(config)) {
      console.log(`✅ 数据库已在运行：http://${config.host}:${config.port}`)
      return
    }
    throw new Error(`已存在运行中的 PocketBase 进程（pid ${existingPid}）但未响应，请先执行：zdcode db stop`)
  }

  const logFd = fs.openSync(paths(dir).log, 'a')
  const child = spawn(binary, ['serve', '--dir', paths(dir).data, '--http', `${config.host}:${config.port}`], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  child.unref()
  fs.writeFileSync(paths(dir).pid, String(child.pid), 'utf-8')
  fs.closeSync(logFd)

  console.log(`⏳ 正在启动 PocketBase（pid ${child.pid}）...`)
  if (!(await waitForServer(config))) {
    fs.rmSync(paths(dir).pid, { force: true })
    console.error(`❌ 启动超时，最近日志：\n${tailLog(dir)}`)
    throw new Error(`启动失败，可查看日志：${paths(dir).log}`)
  }

  console.log('✅ 数据库已启动')
  console.log(`- 地址：http://${config.host}:${config.port}`)
  console.log(`- 管理后台：${adminUrl(config)}`)
  console.log(`- 数据目录：${paths(dir).data}`)
  console.log(`- 日志文件：${paths(dir).log}`)
}

const dbStop = async (options: DbOptions) => {
  const dir = dbDir(options.dir)
  const config = readConfig(dir, options)
  const pidPath = paths(dir).pid
  const pid = readPid(dir)

  if (!pid || !isAlive(pid)) {
    fs.rmSync(pidPath, { force: true })
    console.log('ℹ️  数据库未在运行')
    return
  }

  process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (isAlive(pid)) process.kill(pid, 'SIGKILL')
  fs.rmSync(pidPath, { force: true })

  console.log('✅ 数据库已停止')
  console.log(`- 地址：http://${config.host}:${config.port}（已关闭）`)
}

const dbStatus = async (options: DbOptions) => {
  const dir = dbDir(options.dir)
  const config = readConfig(dir, options)
  const running = await isServing(config)

  console.log(running ? '✅ 数据库运行中' : '⏹  数据库未运行')
  console.log(`- 地址：http://${config.host}:${config.port}`)
  console.log(`- 管理后台：${adminUrl(config)}`)
  console.log(`- 数据目录：${paths(dir).data}`)
  console.log(`- 管理员账号：${config.email}`)
}

const dbWeb = async (options: DbOptions) => {
  const dir = dbDir(options.dir)
  const config = readConfig(dir, options)
  const url = adminUrl(config)

  if (!(await isServing(config))) {
    console.log(`ℹ️  数据库未在运行，页面可能无法访问，请先执行：zdcode db start${options.dir ? ` --dir ${dir}` : ''}`)
  }

  console.log(`🌐 正在打开管理后台：${url}`)
  openBrowser(url)
}

const registerDbModule = (program: Command) => {
  const db = program.command('db').description('管理本地 PocketBase 数据库')

  db.command('init')
    .description('初始化数据库（下载 PocketBase 并创建管理员账号）')
    .option('--dir <path>', '数据库目录', undefined)
    .option('--email <email>', '管理员邮箱', DEFAULT_EMAIL)
    .option('--password <password>', '管理员密码', DEFAULT_PASSWORD)
    .action(async (options: DbOptions) => {
      try {
        await dbInit(options)
      } catch (error) {
        console.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
      }
    })

  db.command('start')
    .description(`启动数据库（默认 ${DEFAULT_HOST}:${DEFAULT_PORT}）`)
    .option('--dir <path>', '数据库目录')
    .option('--host <host>', '监听地址')
    .option('--port <port>', '监听端口')
    .action(async (options: DbOptions) => {
      try {
        await dbStart(options)
      } catch (error) {
        console.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
      }
    })

  db.command('stop')
    .description('停止数据库')
    .option('--dir <path>', '数据库目录')
    .action(async (options: DbOptions) => {
      try {
        await dbStop(options)
      } catch (error) {
        console.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
      }
    })

  db.command('status')
    .description('查看数据库运行状态')
    .option('--dir <path>', '数据库目录')
    .action(async (options: DbOptions) => {
      try {
        await dbStatus(options)
      } catch (error) {
        console.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
      }
    })

  db.command('web')
    .description('在浏览器中打开 PocketBase 管理后台')
    .option('--dir <path>', '数据库目录')
    .action(async (options: DbOptions) => {
      try {
        await dbWeb(options)
      } catch (error) {
        console.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
      }
    })
}

export default registerDbModule
