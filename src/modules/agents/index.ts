import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { Command } from 'commander'

const AGENTS_REPO_URL = 'https://github.com/formonster/zdcode-agents.git'
const agentsRoot = path.resolve(os.homedir(), '.zdcode', 'agents')

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

const runGit = (args: string[], cwd?: string) => {
  execFileSync('git', args, {
    cwd,
    stdio: 'inherit',
  })
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

const ensureAgentsRepo = (options: { update: boolean }) => {
  if (!targetExists(agentsRoot)) {
    fs.mkdirSync(path.dirname(agentsRoot), { recursive: true })
    console.log(`Cloning agents repo into ${agentsRoot}`)
    runGit(['clone', AGENTS_REPO_URL, agentsRoot])
    return
  }

  if (!isGitRepo(agentsRoot)) {
    throw new Error(`${agentsRoot} already exists but is not a git repository.`)
  }

  if (options.update) {
    console.log(`Updating agents repo in ${agentsRoot}`)
    runGit(['pull', '--ff-only'], agentsRoot)
  } else {
    console.log(`Agents repo already exists: ${agentsRoot}`)
  }
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

const runAgentsInit = (options: { update: boolean }) => {
  ensureAgentsRepo(options)
  syncSkills()
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
