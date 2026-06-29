import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync, spawnSync } from 'child_process'
import { Command } from 'commander'

const AGENTS_REPO_URL = 'https://github.com/formonster/zdcode-agents.git'
const agentsRoot = path.resolve(os.homedir(), '.zdcode', 'agents')
const extensionsRoot = path.resolve(os.homedir(), '.zdcode', 'extensions')

const candidateDirs = [
  {
    name: 'Claude Code',
    appRoot: path.resolve(os.homedir(), '.claude'),
    dir: path.resolve(os.homedir(), '.claude', 'skills'),
  },
  {
    name: 'Codex',
    appRoot: path.resolve(os.homedir(), '.codex'),
    dir: path.resolve(os.homedir(), '.codex', 'skills'),
  },
  {
    name: 'Hermes',
    appRoot: path.resolve(os.homedir(), '.hermes'),
    dir: path.resolve(os.homedir(), '.hermes', 'skills'),
  },
  {
    name: 'Pi',
    appRoot: path.resolve(os.homedir(), '.pi'),
    dir: path.resolve(os.homedir(), '.pi', 'agent', 'skills'),
  },
]

const extensionRepos = [
  {
    name: 'vscode-workflow-plan',
    url: 'https://github.com/formonster/vscode-workflow-plan.git',
  },
  {
    name: 'vscode-md-preview',
    url: 'https://github.com/formonster/vscode-md-preview.git',
  },
]

const editorApps = [
  {
    name: 'VS Code',
    cliCandidates: [
      'code',
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    ],
  },
  {
    name: 'Trae',
    cliCandidates: [
      'trae',
      '/Applications/Trae.app/Contents/Resources/app/bin/trae',
    ],
  },
]

const runGit = (args: string[], cwd?: string) => {
  execFileSync('git', args, {
    cwd,
    stdio: 'inherit',
  })
}

const runCommand = (command: string, args: string[], cwd?: string) => {
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
  })
}

const runCommandText = (command: string, args: string[], cwd?: string) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} ${args.join(' ')} failed`)
  }

  return result.stdout
}

const exists = (filePath: string) => {
  try {
    fs.lstatSync(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

const targetExists = (filePath: string) => fs.existsSync(filePath)

const isGitRepo = (dir: string) => exists(path.join(dir, '.git'))

const findOnPath = (command: string) => {
  if (command.includes(path.sep)) return targetExists(command) ? command : undefined

  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, command)
    if (targetExists(candidate)) return candidate
  }

  return undefined
}

const findCli = (candidates: string[]) => {
  for (const candidate of candidates) {
    const found = findOnPath(candidate)
    if (found) return found
  }

  return undefined
}

const readJsonFile = <T = any>(filePath: string): T => JSON.parse(fs.readFileSync(filePath, 'utf-8'))

const ensureGitRepo = (options: { dir: string; url: string; update: boolean; label: string }) => {
  if (!targetExists(options.dir)) {
    fs.mkdirSync(path.dirname(options.dir), { recursive: true })
    console.log(`Cloning ${options.label} into ${options.dir}`)
    runGit(['clone', options.url, options.dir])
    return
  }

  if (!isGitRepo(options.dir)) {
    throw new Error(`${options.dir} already exists but is not a git repository.`)
  }

  if (options.update) {
    console.log(`Updating ${options.label} in ${options.dir}`)
    runGit(['pull', '--ff-only'], options.dir)
  } else {
    console.log(`${options.label} already exists: ${options.dir}`)
  }
}

const ensureAgentsRepo = (options: { update: boolean }) => {
  ensureGitRepo({
    dir: agentsRoot,
    url: AGENTS_REPO_URL,
    update: options.update,
    label: 'agents repo',
  })
}

const readSkillEntries = () => {
  const skillsDir = path.join(agentsRoot, 'skills')
  if (!targetExists(skillsDir)) {
    throw new Error(`Agents repo does not contain a skills directory: ${skillsDir}`)
  }

  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => ({
      name: entry.name,
      source: path.join(skillsDir, entry.name),
    }))
}

const sameSymlinkTarget = (linkPath: string, targetPath: string) => {
  try {
    const currentTarget = fs.readlinkSync(linkPath)
    const resolvedCurrentTarget = path.resolve(path.dirname(linkPath), currentTarget)
    return resolvedCurrentTarget === targetPath
  } catch {
    return false
  }
}

const isManagedSkillSymlink = (linkPath: string) => {
  try {
    const currentTarget = fs.readlinkSync(linkPath)
    const resolvedCurrentTarget = path.resolve(path.dirname(linkPath), currentTarget)
    return resolvedCurrentTarget.startsWith(`${path.join(agentsRoot, 'skills')}${path.sep}`)
  } catch {
    return false
  }
}

const removeStaleManagedSkillLinks = (dir: string, activeSkillNames: Set<string>) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isSymbolicLink() || activeSkillNames.has(entry.name)) continue

    const linkPath = path.join(dir, entry.name)
    if (!isManagedSkillSymlink(linkPath)) continue

    fs.unlinkSync(linkPath)
    console.log(`  removed stale ${entry.name}`)
  }
}

const syncSkills = () => {
  const skills = readSkillEntries()
  const activeSkillNames = new Set(skills.map((skill) => skill.name))

  for (const candidate of candidateDirs) {
    if (!targetExists(candidate.appRoot)) {
      console.log(`Skip ${candidate.name}: ${candidate.appRoot} does not exist`)
      continue
    }

    fs.mkdirSync(candidate.dir, { recursive: true })
    console.log(`Sync ${candidate.name}: ${candidate.dir}`)
    removeStaleManagedSkillLinks(candidate.dir, activeSkillNames)

    for (const skill of skills) {
      const linkPath = path.join(candidate.dir, skill.name)

      if (!exists(linkPath)) {
        fs.symlinkSync(skill.source, linkPath, 'dir')
        console.log(`  linked ${skill.name}`)
        continue
      }

      const stat = fs.lstatSync(linkPath)
      if (stat.isSymbolicLink() && sameSymlinkTarget(linkPath, skill.source)) {
        console.log(`  ok ${skill.name}`)
        continue
      }

      console.warn(`  skip ${skill.name}: ${linkPath} already exists and is not managed by zdcode`)
    }
  }
}

const packageManagerFor = (repoDir: string) => {
  if (targetExists(path.join(repoDir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (targetExists(path.join(repoDir, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

const installDependencies = (repoDir: string) => {
  const packageManager = packageManagerFor(repoDir)
  if (packageManager === 'pnpm') {
    runCommand('pnpm', ['install', '--frozen-lockfile'], repoDir)
    return
  }
  if (packageManager === 'yarn') {
    runCommand('yarn', ['install', '--frozen-lockfile'], repoDir)
    return
  }
  runCommand('npm', ['install'], repoDir)
}

const runBuildScript = (repoDir: string, scripts: Record<string, string> = {}) => {
  const packageManager = packageManagerFor(repoDir)
  const scriptName = ['compile', 'build'].find((script) => scripts[script])
  if (!scriptName) return

  if (packageManager === 'pnpm') {
    runCommand('pnpm', ['run', scriptName], repoDir)
    return
  }
  if (packageManager === 'yarn') {
    runCommand('yarn', [scriptName], repoDir)
    return
  }
  runCommand('npm', ['run', scriptName], repoDir)
}

const compareVersionIdentifiers = (left: string, right: string) => {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : undefined
  const rightNumber = /^\d+$/.test(right) ? Number(right) : undefined

  if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber
  if (leftNumber !== undefined) return -1
  if (rightNumber !== undefined) return 1
  return left.localeCompare(right)
}

const compareVersions = (left: string, right: string) => {
  const [leftMain, leftPrerelease = ''] = left.split('-', 2)
  const [rightMain, rightPrerelease = ''] = right.split('-', 2)
  const leftParts = leftMain.split('.').map((part) => Number(part) || 0)
  const rightParts = rightMain.split('.').map((part) => Number(part) || 0)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] || 0) - (rightParts[index] || 0)
    if (diff !== 0) return diff
  }

  if (!leftPrerelease && !rightPrerelease) return 0
  if (!leftPrerelease) return 1
  if (!rightPrerelease) return -1

  const leftPrereleaseParts = leftPrerelease.split('.')
  const rightPrereleaseParts = rightPrerelease.split('.')
  const prereleaseLength = Math.max(leftPrereleaseParts.length, rightPrereleaseParts.length)

  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftPart = leftPrereleaseParts[index]
    const rightPart = rightPrereleaseParts[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1

    const diff = compareVersionIdentifiers(leftPart, rightPart)
    if (diff !== 0) return diff
  }

  return 0
}

const extensionIdFromPackageJson = (packageJson: { name?: string; publisher?: string }) => {
  if (!packageJson.publisher || !packageJson.name) {
    throw new Error('VS Code extension package.json must contain publisher and name.')
  }

  return `${packageJson.publisher}.${packageJson.name}`
}

const findVsix = (repoDir: string, packageJson: { name?: string; version?: string }) => {
  const prefix = `${packageJson.name}-${packageJson.version}`
  const candidates = fs
    .readdirSync(repoDir)
    .filter((file) => file.endsWith('.vsix'))
    .map((file) => path.join(repoDir, file))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)

  return candidates.find((candidate) => path.basename(candidate).startsWith(prefix)) || candidates[0]
}

const packageVsix = (repoDir: string, packageJson: { name?: string; version?: string }) => {
  runCommand('npx', ['--yes', '@vscode/vsce', 'package'], repoDir)

  const vsix = findVsix(repoDir, packageJson)
  if (!vsix) throw new Error(`No VSIX package found after packaging ${repoDir}.`)
  return vsix
}

const getInstalledExtensionVersion = (cli: string, extensionId: string) => {
  const output = runCommandText(cli, ['--list-extensions', '--show-versions'])
  const normalizedExtensionId = extensionId.toLowerCase()
  const line = output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.toLowerCase().startsWith(`${normalizedExtensionId}@`))

  return line ? line.slice(extensionId.length + 1) : undefined
}

const installExtensionIfNeeded = (options: {
  appName: string
  cli: string
  extensionId: string
  version: string
  vsix: string
}) => {
  let installedVersion: string | undefined
  try {
    installedVersion = getInstalledExtensionVersion(options.cli, options.extensionId)
  } catch (error) {
    console.warn(
      `Skip ${options.appName}: unable to inspect installed extensions: ${error instanceof Error ? error.message : String(error)}`
    )
    return
  }

  if (installedVersion && compareVersions(options.version, installedVersion) <= 0) {
    console.log(
      `Skip ${options.appName}: ${options.extensionId}@${installedVersion} is already installed, local version is ${options.version}`
    )
    return
  }

  console.log(`Install ${options.extensionId}@${options.version} to ${options.appName}`)
  runCommand(options.cli, ['--install-extension', options.vsix, '--force'])
}

const syncExtensions = (options: { update: boolean }) => {
  for (const repo of extensionRepos) {
    const repoDir = path.join(extensionsRoot, repo.name)
    ensureGitRepo({
      dir: repoDir,
      url: repo.url,
      update: options.update,
      label: repo.name,
    })

    const packageJsonPath = path.join(repoDir, 'package.json')
    if (!targetExists(packageJsonPath)) {
      throw new Error(`${repo.name} does not contain package.json: ${packageJsonPath}`)
    }

    const packageJson = readJsonFile<{
      name?: string
      publisher?: string
      version?: string
      scripts?: Record<string, string>
    }>(packageJsonPath)

    if (!packageJson.version) throw new Error(`${repo.name} package.json must contain version.`)

    console.log(`Build ${repo.name}@${packageJson.version}`)
    installDependencies(repoDir)
    runBuildScript(repoDir, packageJson.scripts)
    const vsix = packageVsix(repoDir, packageJson)
    const extensionId = extensionIdFromPackageJson(packageJson)

    for (const app of editorApps) {
      const cli = findCli(app.cliCandidates)
      if (!cli) {
        console.log(`Skip ${app.name}: command not found`)
        continue
      }

      installExtensionIfNeeded({
        appName: app.name,
        cli,
        extensionId,
        version: packageJson.version,
        vsix,
      })
    }
  }
}

const runAgentsInit = (options: { update: boolean }) => {
  ensureAgentsRepo(options)
  syncSkills()
  syncExtensions(options)
}

const registerAgentsModule = (program: Command) => {
  const agents = program.command('agents').description('管理 zdcode agents 技能仓库与本机 Agent 应用软链')

  agents
    .command('init')
    .description('初始化 ~/.zdcode/agents 仓库，并同步技能软链')
    .action(() => {
      try {
        runAgentsInit({ update: false })
      } catch (error) {
        console.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })

  agents
    .command('update')
    .description('更新 ~/.zdcode/agents 仓库，并刷新技能软链')
    .action(() => {
      try {
        runAgentsInit({ update: true })
      } catch (error) {
        console.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })
}

export default registerAgentsModule
