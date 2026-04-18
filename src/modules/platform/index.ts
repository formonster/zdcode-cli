import fs from 'fs'
import { Command } from 'commander'
import {
  ensureRuntimeAvailable,
  fetchJson,
  openBrowser,
  platformBaseUrl,
  readPidIfExists,
  RuntimeHealth,
  runtimeAlreadyHealthy,
  spawnRuntimeForeground,
  startRuntimeDetached,
  tryFetchHealth,
  waitForRuntime,
  ZDCODE_PLATFORM_HOST,
  ZDCODE_PLATFORM_PID,
  ZDCODE_PLATFORM_PORT,
} from '../../utils/platform'

type AgentCreateOptions = {
  name: string
  description?: string
  model?: string
  workspace?: string
  persona?: string
  personaFile?: string
  skills?: string
  skillsFile?: string
  toolProfile?: string
  memoryProvider?: string
  enabled?: boolean
}

type AgentEditOptions = Partial<AgentCreateOptions>

type TaskStartOptions = {
  title?: string
  prompt: string
  entryAgent: string
  enableAgent?: string[]
  maxTurns?: string
}

type RuntimeServeOptions = {
  host?: string
  port?: string
}

const readOptionalText = (value?: string, file?: string) => {
  if (typeof value === 'string' && value.trim()) {
    return value
  }
  if (file?.trim()) {
    return fs.readFileSync(file.trim(), 'utf-8')
  }
  return ''
}

const parseToolProfile = (raw?: string) => {
  if (!raw?.trim()) {
    return {
      shell: true,
      filesystem: true,
      browser: false,
    }
  }

  return JSON.parse(raw)
}

const printJson = (payload: unknown) => {
  console.log(JSON.stringify(payload, null, 2))
}

const registerDashboard = (program: Command) => {
  program
    .command('dashboard')
    .description('启动本地多智能体 dashboard 并自动打开浏览器')
    .action(async () => {
      const baseUrl = platformBaseUrl()
      const healthy = await runtimeAlreadyHealthy(baseUrl)
      if (!healthy) {
        startRuntimeDetached(baseUrl)
      }

      const health = await waitForRuntime(baseUrl)
      console.log('✅ ZDCode dashboard ready')
      console.log(`- url: ${baseUrl}/dashboard/`)
      if (health.runtime) {
        console.log(`- python: ${health.runtime.python || 'unknown'}`)
        console.log(`- agents: ${health.runtime.agentsAvailable ? 'enabled' : 'unavailable'}`)
      }
      openBrowser(`${baseUrl}/dashboard/`)
    })
}

const registerRuntimeModule = (program: Command) => {
  const runtime = program.command('runtime').description('本地多智能体 runtime 服务')

  runtime
    .command('serve')
    .description('前台启动 Python runtime 服务')
    .option('--host <host>', '监听地址', ZDCODE_PLATFORM_HOST)
    .option('--port <port>', '监听端口', String(ZDCODE_PLATFORM_PORT))
    .action((options: RuntimeServeOptions) => {
      const code = spawnRuntimeForeground(options.host || ZDCODE_PLATFORM_HOST, Number(options.port || ZDCODE_PLATFORM_PORT))
      process.exit(code)
    })

  runtime
    .command('run')
    .description('通过 runtime 启动一次任务')
    .requiredOption('--prompt <text>', '任务描述')
    .requiredOption('--entry-agent <id>', '入口主 Agent')
    .option('--title <title>', '任务标题')
    .option('--max-turns <number>', '单个任务允许的最大模型轮次数', String(30))
    .option('--enable-agent <id>', '启用的子 Agent，可重复传入', (value, previous: string[] = []) => {
      previous.push(value)
      return previous
    })
    .action(async (options: TaskStartOptions) => {
      const baseUrl = await ensureRuntimeAvailable()
      const payload = await fetchJson(`${baseUrl}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          title: options.title || options.prompt.slice(0, 48),
          prompt: options.prompt,
          max_turns: Number(options.maxTurns || 30),
          entry_agent_id: options.entryAgent,
          enabled_agent_ids: Array.from(new Set([options.entryAgent, ...(options.enableAgent || [])])),
        }),
      })

      console.log('✅ Task started')
      printJson(payload)
    })

  runtime
    .command('resume <runId>')
    .description('恢复一个被审批中断的 run')
    .action(async (runId: string) => {
      const baseUrl = await ensureRuntimeAvailable()
      const payload = await fetchJson(`${baseUrl}/runs/${runId}/resume`, {
        method: 'POST',
      })
      printJson(payload)
    })

  runtime
    .command('approve <runId>')
    .description('批准某个 run 下的所有 pending 审批')
    .action(async (runId: string) => {
      const baseUrl = await ensureRuntimeAvailable()
      const approvals = await fetchJson<any[]>(`${baseUrl}/approvals?run_id=${encodeURIComponent(runId)}`)
      const pending = approvals.filter((item) => item.status === 'pending')
      for (const item of pending) {
        await fetchJson(`${baseUrl}/approvals/${item.id}/approve`, {
          method: 'POST',
        })
      }
      console.log(`✅ Approved ${pending.length} approval(s)`)
    })

  runtime
    .command('reject <runId>')
    .description('拒绝某个 run 下的所有 pending 审批')
    .action(async (runId: string) => {
      const baseUrl = await ensureRuntimeAvailable()
      const approvals = await fetchJson<any[]>(`${baseUrl}/approvals?run_id=${encodeURIComponent(runId)}`)
      const pending = approvals.filter((item) => item.status === 'pending')
      for (const item of pending) {
        await fetchJson(`${baseUrl}/approvals/${item.id}/reject`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'Rejected from CLI' }),
        })
      }
      console.log(`✅ Rejected ${pending.length} approval(s)`)
    })
}

const registerAgentModule = (program: Command) => {
  const agent = program.command('agent').description('Agent 管理')

  agent
    .command('create')
    .description('创建一个 Agent')
    .requiredOption('--name <name>', 'Agent 名称')
    .option('--description <text>', '说明')
    .option('--model <name>', '默认模型', 'volcengine/ark-code-latest')
    .option('--workspace <path>', '绑定 workspace', process.cwd())
    .option('--persona <text>', 'persona prompt')
    .option('--persona-file <path>', '从文件读取 persona prompt')
    .option('--skills <text>', 'skills prompt')
    .option('--skills-file <path>', '从文件读取 skills prompt')
    .option('--tool-profile <json>', '工具配置 JSON')
    .option('--memory-provider <name>', '长期记忆 provider', 'mem0')
    .action(async (options: AgentCreateOptions) => {
      const baseUrl = await ensureRuntimeAvailable()
      const payload = await fetchJson(`${baseUrl}/agents`, {
        method: 'POST',
        body: JSON.stringify({
          name: options.name,
          description: options.description || '',
          default_model: options.model || 'volcengine/ark-code-latest',
          workspace_binding: options.workspace || process.cwd(),
          persona_prompt: readOptionalText(options.persona, options.personaFile),
          skills_prompt: readOptionalText(options.skills, options.skillsFile),
          tool_profile: parseToolProfile(options.toolProfile),
          memory_policy: {
            provider: options.memoryProvider || 'mem0',
            scope: options.name,
          },
          enabled: options.enabled ?? true,
        }),
      })
      printJson(payload)
    })

  agent
    .command('edit <agentId>')
    .description('更新 Agent 配置')
    .option('--name <name>', 'Agent 名称')
    .option('--description <text>', '说明')
    .option('--model <name>', '默认模型')
    .option('--workspace <path>', '绑定 workspace')
    .option('--persona <text>', 'persona prompt')
    .option('--persona-file <path>', '从文件读取 persona prompt')
    .option('--skills <text>', 'skills prompt')
    .option('--skills-file <path>', '从文件读取 skills prompt')
    .option('--tool-profile <json>', '工具配置 JSON')
    .option('--memory-provider <name>', '长期记忆 provider')
    .action(async (agentId: string, options: AgentEditOptions) => {
      const baseUrl = await ensureRuntimeAvailable()
      const patch: Record<string, unknown> = {}
      if (options.name) patch.name = options.name
      if (options.description !== undefined) patch.description = options.description
      if (options.model) patch.default_model = options.model
      if (options.workspace) patch.workspace_binding = options.workspace
      const persona = readOptionalText(options.persona, options.personaFile)
      const skills = readOptionalText(options.skills, options.skillsFile)
      if (persona) patch.persona_prompt = persona
      if (skills) patch.skills_prompt = skills
      if (options.toolProfile) patch.tool_profile = parseToolProfile(options.toolProfile)
      if (options.memoryProvider) {
        patch.memory_policy = {
          provider: options.memoryProvider,
        }
      }

      const payload = await fetchJson(`${baseUrl}/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
      printJson(payload)
    })

  agent
    .command('ls')
    .description('列出 Agent')
    .action(async () => {
      const baseUrl = await ensureRuntimeAvailable()
      const payload = await fetchJson<any[]>(`${baseUrl}/agents`)
      payload.forEach((item, index) => {
        console.log(`${index + 1}. ${item.name} (${item.id})`)
        console.log(`   model: ${item.default_model}`)
        console.log(`   workspace: ${item.workspace_binding}`)
        console.log(`   enabled: ${item.enabled}`)
      })
    })

  agent
    .command('inspect <agentId>')
    .description('查看 Agent 详情')
    .action(async (agentId: string) => {
      const baseUrl = await ensureRuntimeAvailable()
      const payload = await fetchJson(`${baseUrl}/agents/${agentId}`)
      printJson(payload)
    })
}

const registerTaskModule = (program: Command) => {
  const task = program.command('task').description('任务管理')

  task
    .command('start')
    .description('发起一个任务')
    .requiredOption('--prompt <text>', '任务内容')
    .requiredOption('--entry-agent <id>', '入口主 Agent')
    .option('--title <title>', '任务标题')
    .option('--max-turns <number>', '单个任务允许的最大模型轮次数', String(30))
    .option('--enable-agent <id>', '启用的子 Agent，可重复传入', (value, previous: string[] = []) => {
      previous.push(value)
      return previous
    })
    .action(async (options: TaskStartOptions) => {
      const baseUrl = await ensureRuntimeAvailable()
      const payload = await fetchJson(`${baseUrl}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          title: options.title || options.prompt.slice(0, 48),
          prompt: options.prompt,
          max_turns: Number(options.maxTurns || 30),
          entry_agent_id: options.entryAgent,
          enabled_agent_ids: Array.from(new Set([options.entryAgent, ...(options.enableAgent || [])])),
        }),
      })

      printJson(payload)
    })

  task
    .command('ls')
    .description('列出任务')
    .action(async () => {
      const baseUrl = await ensureRuntimeAvailable()
      const payload = await fetchJson<any[]>(`${baseUrl}/tasks`)
      payload.forEach((item, index) => {
        console.log(`${index + 1}. ${item.title} (${item.id}) [${item.status}]`)
        console.log(`   entry: ${item.entry_agent_name || item.entry_agent_id}`)
        console.log(`   active: ${item.active_agent_name || '-'}`)
      })
    })

  task
    .command('inspect <taskId>')
    .description('查看任务详情')
    .action(async (taskId: string) => {
      const baseUrl = await ensureRuntimeAvailable()
      const payload = await fetchJson(`${baseUrl}/tasks/${taskId}`)
      printJson(payload)
    })
}

const registerSessionModule = (program: Command) => {
  const session = program.command('session').description('会话查看')

  session
    .command('ls')
    .description('列出会话')
    .action(async () => {
      const baseUrl = await ensureRuntimeAvailable()
      const payload = await fetchJson<any[]>(`${baseUrl}/sessions`)
      payload.forEach((item, index) => {
        console.log(`${index + 1}. ${item.title} (${item.id}) [${item.status}]`)
        console.log(`   entry: ${item.entry_agent_name || item.entry_agent_id}`)
        console.log(`   participants: ${(item.participating_agents || []).join(', ') || '-'}`)
      })
    })

  session
    .command('inspect <sessionId>')
    .description('查看会话详情')
    .action(async (sessionId: string) => {
      const baseUrl = await ensureRuntimeAvailable()
      const payload = await fetchJson(`${baseUrl}/sessions/${sessionId}`)
      printJson(payload)
    })
}

const registerMemoryModule = (program: Command) => {
  const memory = program.command('memory').description('长期记忆管理')

  memory
    .command('ls')
    .description('列出记忆 scope')
    .action(async () => {
      const baseUrl = await ensureRuntimeAvailable()
      const payload = await fetchJson<any[]>(`${baseUrl}/memory/scopes`)
      payload.forEach((item, index) => {
        console.log(`${index + 1}. ${item.scope_id} (${item.provider})`)
        console.log(`   episodes: ${item.episode_count}`)
      })
    })

  memory
    .command('inspect <scopeId>')
    .description('查看某个记忆 scope')
    .action(async (scopeId: string) => {
      const baseUrl = await ensureRuntimeAvailable()
      const payload = await fetchJson(`${baseUrl}/memory/scopes/${scopeId}`)
      printJson(payload)
    })

  memory
    .command('rebuild <scopeId>')
    .description('重建记忆摘要')
    .action(async (scopeId: string) => {
      const baseUrl = await ensureRuntimeAvailable()
      const payload = await fetchJson(`${baseUrl}/memory/scopes/${scopeId}/rebuild`, {
        method: 'POST',
      })
      printJson(payload)
    })

  memory
    .command('prune <scopeId>')
    .description('清理某个记忆 scope')
    .action(async (scopeId: string) => {
      const baseUrl = await ensureRuntimeAvailable()
      const payload = await fetchJson(`${baseUrl}/memory/scopes/${scopeId}/prune`, {
        method: 'POST',
      })
      printJson(payload)
    })
}

const registerModelModule = (program: Command) => {
  const model = program.command('model').description('模型注册表管理')

  model
    .command('ls')
    .description('列出已配置模型')
    .action(async () => {
      const baseUrl = await ensureRuntimeAvailable()
      const payload = await fetchJson<any[]>(`${baseUrl}/models`)
      payload.forEach((item, index) => {
        console.log(`${index + 1}. ${item.model_key}${item.is_default ? ' [default]' : ''}`)
        console.log(`   provider: ${item.provider}`)
        console.log(`   name: ${item.alias || item.display_name}`)
        console.log(`   api_key: ${item.api_key_present ? 'present' : 'missing'}`)
      })
    })

  model
    .command('inspect <modelKey>')
    .description('查看模型详情')
    .action(async (modelKey: string) => {
      const baseUrl = await ensureRuntimeAvailable()
      const payload = await fetchJson(`${baseUrl}/models/${modelKey}`)
      printJson(payload)
    })

  model
    .command('sync')
    .description('从 openclaw 配置同步模型列表')
    .action(async () => {
      const baseUrl = await ensureRuntimeAvailable()
      const payload = await fetchJson(`${baseUrl}/models/sync`, {
        method: 'POST',
      })
      printJson(payload)
    })

  model
    .command('set-default <modelKey>')
    .description('设置系统默认模型')
    .action(async (modelKey: string) => {
      const baseUrl = await ensureRuntimeAvailable()
      const payload = await fetchJson(`${baseUrl}/models/default`, {
        method: 'POST',
        body: JSON.stringify({ model_key: modelKey }),
      })
      printJson(payload)
    })
}

const registerTraceModule = (program: Command) => {
  const trace = program.command('trace').description('运行追踪')

  trace
    .command('ls')
    .description('列出 run trace')
    .action(async () => {
      const baseUrl = await ensureRuntimeAvailable()
      const payload = await fetchJson<any[]>(`${baseUrl}/traces`)
      payload.forEach((item, index) => {
        console.log(`${index + 1}. ${item.agent_name} (${item.id}) [${item.status}]`)
        console.log(`   task: ${item.task_session_id}`)
        console.log(`   output: ${item.final_output_preview || '-'}`)
      })
    })

  trace
    .command('inspect <runId>')
    .description('查看 run trace')
    .action(async (runId: string) => {
      const baseUrl = await ensureRuntimeAvailable()
      const payload = await fetchJson(`${baseUrl}/traces/${runId}`)
      printJson(payload)
    })
}

const registerDoctor = (program: Command) => {
  program
    .command('doctor')
    .description('检查 runtime、依赖与本地状态')
    .action(async () => {
      const baseUrl = platformBaseUrl()
      const health = await tryFetchHealth(baseUrl)
      const pid = readPidIfExists()
      if (!health) {
        console.log('⚠️ runtime not reachable')
        if (pid) {
          console.log(`- last pid: ${pid}`)
        }
        if (fs.existsSync(ZDCODE_PLATFORM_PID)) {
          console.log(`- pid file: ${ZDCODE_PLATFORM_PID}`)
        }
        return
      }

      const typedHealth = health as RuntimeHealth
      console.log('✅ runtime reachable')
      console.log(`- status: ${typedHealth.status || 'unknown'}`)
      console.log(`- url: ${baseUrl}`)
      if (typedHealth.runtime) {
        console.log(`- python: ${typedHealth.runtime.python || 'unknown'}`)
        console.log(`- agents: ${typedHealth.runtime.agentsAvailable ? 'yes' : 'no'}`)
        console.log(`- mem0: ${typedHealth.runtime.mem0Available ? 'yes' : 'no'}`)
        console.log(`- playwright: ${typedHealth.runtime.playwrightAvailable ? 'yes' : 'no'}`)
        console.log(`- openai_api_key: ${typedHealth.runtime.openAIApiKey ? 'set' : 'missing'}`)
        console.log(`- default_model: ${typedHealth.runtime.defaultModel || 'unknown'}`)
        console.log(`- model_count: ${typedHealth.runtime.modelCount ?? 0}`)
      }
      if (typedHealth.database) {
        console.log(`- db: ${typedHealth.database.path}`)
      }
    })
}

const registerPlatformModule = (program: Command) => {
  registerDashboard(program)
  registerRuntimeModule(program)
  registerAgentModule(program)
  registerTaskModule(program)
  registerSessionModule(program)
  registerModelModule(program)
  registerMemoryModule(program)
  registerTraceModule(program)
  registerDoctor(program)
}

export default registerPlatformModule
