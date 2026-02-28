import fs from 'fs'
import path from 'path'
import { Command } from 'commander'
import { spawnSync } from 'child_process'
import {
  defaultConfig,
  DevConfig,
  ensureDir,
  ensureGitignoreEntry,
  ensureGlobalDirs,
  getGitRoot,
  isGitRepo,
  nowStamp,
  quote,
  readProjectConfig,
  readSessions,
  run,
  sessionRunning,
  slugify,
  shortHash,
  upsertSession,
  writeProjectConfig,
  ZDCODE_LOG_DIR,
  ZDCODE_RUNNER_DIR,
} from '../../utils/dev'

type UpOptions = {
  task: string
  mr?: boolean
  mrTarget?: string
  mrTitle?: string
  notify?: boolean
}

const requireGitRepo = (cwd: string) => {
  if (!isGitRepo(cwd)) {
    console.error('❌ 当前目录不是 git 仓库，请先进入项目目录')
    process.exit(1)
  }
}

const ensureProjectConfig = (projectRoot: string) => {
  const addedIgnore = ensureGitignoreEntry(projectRoot, '.worktrees/')
  if (addedIgnore) {
    console.log('ℹ️ 已自动在 .gitignore 中添加 .worktrees/')
  }

  let config = readProjectConfig(projectRoot)
  if (!config) {
    config = defaultConfig(projectRoot)
    writeProjectConfig(projectRoot, config)
    console.log('ℹ️ 未检测到 .zdcode/dev.json，已自动初始化')
  }
  return config
}

const createRunnerScript = (
  sessionName: string,
  worktreePath: string,
  logPath: string,
  codexCommand: string,
  task: string,
  branch: string,
  options: { mrEnabled: boolean; mrTarget: string; mrTitle: string; notify: boolean }
) => {
  ensureGlobalDirs()
  const scriptPath = path.join(ZDCODE_RUNNER_DIR, `${sessionName}.sh`)
  const D = '$'

  const script = `#!/usr/bin/env bash
set -euo pipefail

cd ${quote(worktreePath)}
TASK=${quote(task)}
BRANCH=${quote(branch)}
MR_ENABLED=${options.mrEnabled ? '1' : '0'}
MR_TARGET=${quote(options.mrTarget)}
MR_TITLE=${quote(options.mrTitle)}
NOTIFY=${options.notify ? '1' : '0'}

log_notify() {
  local text="${D}1"
  if [[ "${D}NOTIFY" == "1" ]] && command -v openclaw >/dev/null 2>&1; then
    openclaw system event --text "${D}text" --mode now >/dev/null 2>&1 || true
  fi
}

{
  ${codexCommand} "${D}TASK"
} 2>&1 | tee -a ${quote(logPath)}

MR_URL=""
STATUS="done"

if [[ "${D}MR_ENABLED" == "1" ]]; then
  if git diff --quiet && git diff --cached --quiet; then
    STATUS="no_changes"
  else
    git add -A
    git commit -m "chore: ${D}TASK" >/dev/null 2>&1 || true
    PUSH_OUTPUT=$(git push -u origin "${D}BRANCH" 2>&1)
    echo "${D}PUSH_OUTPUT" | tee -a ${quote(logPath)}
    MR_URL=$(printf '%s\n' "${D}PUSH_OUTPUT" | grep -Eo 'https?://[^ ]+merge_requests[^ ]*' | tail -1 || true)

    if [[ -z "${D}MR_URL" ]] && command -v glab >/dev/null 2>&1; then
      MR_OUTPUT=$(glab mr create --source-branch "${D}BRANCH" --target-branch "${D}MR_TARGET" --title "${D}MR_TITLE" --description "${D}TASK" --yes 2>&1 || true)
      echo "${D}MR_OUTPUT" | tee -a ${quote(logPath)}
      MR_URL=$(printf '%s\n' "${D}MR_OUTPUT" | grep -Eo 'https?://[^ ]+' | tail -1 || true)
    fi

    if [[ -z "${D}MR_URL" ]]; then
      STATUS="mr_failed"
    fi
  fi
fi

if [[ "${D}STATUS" == "done" && -n "${D}MR_URL" ]]; then
  log_notify "✅ 任务完成：${D}TASK | MR: ${D}MR_URL"
elif [[ "${D}STATUS" == "done" ]]; then
  log_notify "✅ 任务完成：${D}TASK"
elif [[ "${D}STATUS" == "no_changes" ]]; then
  log_notify "✅ 任务完成（无代码变更）：${D}TASK"
else
  log_notify "⚠️ 任务完成但 MR 创建失败：${D}TASK（请查看日志 ${logPath}）"
fi
`

  fs.writeFileSync(scriptPath, script)
  fs.chmodSync(scriptPath, 0o755)
  return scriptPath
}


const startTaskSession = (config: DevConfig, projectRoot: string, opts: UpOptions) => {
  const task = opts.task
  const stamp = nowStamp()
  const shortStamp = stamp.slice(-6)
  const taskSlug = slugify(task, 16)
  const projectSlug = slugify(config.projectName, 12)
  const taskId = shortHash(`${task}-${stamp}`, 6)
  const sessionName = `zd-${projectSlug}-${taskSlug}-${taskId}-${shortStamp}`.slice(0, 64)

  const worktreeRoot = config.worktreeRoot
  ensureDir(worktreeRoot)

  const branch = `task/${taskSlug}-${taskId}`
  const worktreePath = path.join(worktreeRoot, `${taskSlug}-${taskId}`)
  const logPath = path.join(ZDCODE_LOG_DIR, `${sessionName}.log`)

  run(`git worktree add -b ${quote(branch)} ${quote(worktreePath)} ${quote(config.baseBranch)}`, projectRoot)

  const mrTarget = opts.mrTarget || config.baseBranch
  const mrTitle = opts.mrTitle || `feat: ${task.slice(0, 60)}`

  const runner = createRunnerScript(sessionName, worktreePath, logPath, config.codexCommand, task, branch, {
    mrEnabled: Boolean(opts.mr),
    mrTarget,
    mrTitle,
    notify: Boolean(opts.notify),
  })

  run(`tmux new-session -d -s ${quote(sessionName)} -c ${quote(worktreePath)} ${quote(`bash ${runner}`)}`)

  upsertSession({
    sessionName,
    projectRoot,
    worktreePath,
    branch,
    task,
    taskSlug,
    logPath,
    createdAt: new Date().toISOString(),
  })

  console.log('✅ 已创建任务会话')
  console.log(`- session: ${sessionName}`)
  console.log(`- branch:  ${branch}`)
  console.log(`- worktree:${worktreePath}`)
  console.log(`- logs:    ${logPath}`)
  if (opts.mr) {
    console.log(`- mr:      enabled (target=${mrTarget})`)
  }
  if (opts.notify) {
    console.log('- notify:  enabled (openclaw system event)')
  }
  console.log(`\n可用命令: zdcode dev attach ${sessionName}`)
}

const registerInit = (dev: Command) => {
  dev
    .command('init')
    .description('初始化当前项目的 .zdcode/dev.json 配置')
    .action(() => {
      const cwd = process.cwd()
      requireGitRepo(cwd)
      const projectRoot = getGitRoot(cwd)
      const addedIgnore = ensureGitignoreEntry(projectRoot, '.worktrees/')
      if (addedIgnore) {
        console.log('✅ 已在 .gitignore 中添加 .worktrees/')
      }

      const exists = readProjectConfig(projectRoot)
      if (exists) {
        console.log('✅ 已存在 .zdcode/dev.json')
        return
      }

      const config = defaultConfig(projectRoot)
      writeProjectConfig(projectRoot, config)
      console.log('✅ 初始化成功: .zdcode/dev.json')
    })
}

const registerUp = (dev: Command) => {
  dev
    .command('up')
    .description('创建任务会话（tmux + git worktree + codex 非交互）')
    .requiredOption('--task <text>', '任务描述（必填）')
    .option('--mr', '任务完成后自动 push 并创建 Merge Request')
    .option('--mr-target <branch>', 'MR 目标分支，默认使用配置里的 baseBranch')
    .option('--mr-title <title>', 'MR 标题，不传则自动生成')
    .option('--notify', '任务完成后发送 openclaw system event 通知')
    .action((options: UpOptions) => {
      const cwd = process.cwd()
      requireGitRepo(cwd)
      const projectRoot = getGitRoot(cwd)
      const config = ensureProjectConfig(projectRoot)
      startTaskSession(config, projectRoot, options)
    })
}

const registerLs = (dev: Command) => {
  dev
    .command('ls')
    .description('查看任务会话列表')
    .action(() => {
      const rows = readSessions()
      if (!rows.length) {
        console.log('暂无任务会话')
        return
      }

      rows.forEach((item, idx) => {
        const running = sessionRunning(item.sessionName) ? 'RUNNING' : 'STOPPED'
        console.log(`\n${idx + 1}. ${item.sessionName} [${running}]`)
        console.log(`   task: ${item.task}`)
        console.log(`   branch: ${item.branch}`)
        console.log(`   worktree: ${item.worktreePath}`)
      })
    })
}

const registerAttach = (dev: Command) => {
  dev
    .command('attach [sessionName]')
    .description('附着到 tmux 会话，不传则附着到最近会话')
    .action((sessionName?: string) => {
      const list = readSessions()
      if (!list.length) {
        console.log('暂无可附着会话')
        return
      }

      const target = sessionName ? list.find((item) => item.sessionName === sessionName) : list[0]
      if (!target) {
        console.error(`❌ 未找到会话: ${sessionName}`)
        process.exit(1)
      }

      if (!sessionRunning(target.sessionName)) {
        console.error(`❌ 会话未运行: ${target.sessionName}`)
        process.exit(1)
      }

      console.log(`🔗 attaching: ${target.sessionName}`)
      const res = spawnSync('tmux', ['attach', '-t', target.sessionName], { stdio: 'inherit' })
      process.exit(res.status ?? 0)
    })
}

const registerDevModule = (program: Command) => {
  const dev = program.command('dev').description('tmux + codex 工作流')
  registerInit(dev)
  registerUp(dev)
  registerLs(dev)
  registerAttach(dev)
}

export default registerDevModule
