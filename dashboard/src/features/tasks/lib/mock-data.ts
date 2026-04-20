import type { AgentProfile, ChannelBinding, ChannelConnection, ModelRecord, RuntimeHealth, SkillRecord, TaskSession } from '@/shared/types/runtime'

export const mockHealth: RuntimeHealth = {
  ok: true,
  status: 'degraded',
  runtime: {
    agentsAvailable: true,
    memoryEnabled: false,
    defaultModel: 'volcengine/ark-code-latest',
    openAIApiKey: true,
  },
}

export const mockSkills: SkillRecord[] = [
  {
    id: 'frontend-design',
    name: 'frontend-design',
    description: 'Create distinctive, production-grade frontend interfaces.',
    path: '/Users/ding/.agents/skills/frontend-design/SKILL.md',
  },
  {
    id: 'vercel:agent-browser',
    name: 'vercel:agent-browser',
    description: 'Browser automation CLI for AI agents.',
    path: '/Users/ding/.codex/plugins/cache/openai-curated/vercel/skills/agent-browser/SKILL.md',
  },
  {
    id: 'openai-docs',
    name: 'openai-docs',
    description: 'Official OpenAI docs guidance.',
    path: '/Users/ding/.codex/skills/.system/openai-docs/SKILL.md',
  },
]

export const mockModels: ModelRecord[] = [
  {
    model_key: 'volcengine/ark-code-latest',
    provider: 'volcengine',
    display_name: 'ark-code-latest',
    is_default: true,
  },
  {
    model_key: 'openai/openai-codex',
    provider: 'openai',
    display_name: 'openai-codex',
  },
]

export const mockAgents: AgentProfile[] = [
  {
    id: 'agent-pm',
    name: 'PMAgent',
    description: 'Owns task breakdown, prioritization, and synthesis.',
    avatar_url: '',
    persona_prompt: 'Be concise, skeptical, and operationally sharp.',
    skills_prompt: '',
    agent_identity_prompt: 'You are PMAgent, the task-planning and synthesis agent.',
    agent_responsibility_prompt: 'Clarify the request, break work into steps when needed, and produce concise final summaries.',
    agent_non_goals_prompt: 'Do not pretend implementation or verification happened unless tools actually ran.',
    selected_skills: ['frontend-design', 'openai-docs'],
    default_model: 'volcengine/ark-code-latest',
    workspace_binding: '/Users/ding/zdcode/zdcode-cli',
    channel_config: {
      provider: 'feishu',
      app_id: '',
      app_secret: '',
      domain: 'feishu',
      webhook: '',
      chat_id: '',
      push_enabled: true,
      enabled: false,
    },
    enabled: true,
  },
  {
    id: 'agent-runtime',
    name: 'RuntimeAgent',
    description: 'Inspects traces, tools, prompt payloads, and approvals.',
    avatar_url: '',
    persona_prompt: 'Act like a runtime debugger with a terse style.',
    skills_prompt: '',
    agent_identity_prompt: 'You are RuntimeAgent, a runtime-debugging specialist.',
    agent_responsibility_prompt: 'Inspect traces, prompt payloads, tool calls, and approvals directly from runtime evidence.',
    agent_non_goals_prompt: 'Do not speculate about runtime state when logs, traces, or tool output are available.',
    selected_skills: ['vercel:agent-browser'],
    default_model: 'openai/openai-codex',
    workspace_binding: '/Users/ding/zdcode/zdcode-cli',
    channel_config: {
      provider: 'feishu',
      app_id: '',
      app_secret: '',
      domain: 'feishu',
      webhook: '',
      chat_id: '',
      push_enabled: true,
      enabled: false,
    },
    enabled: true,
  },
]

export const mockTasks: TaskSession[] = [
  {
    id: 'task-1',
    title: 'Desktop inspection',
    prompt: 'Show the first five files on my desktop.',
    status: 'completed',
    entry_agent_id: 'agent-pm',
    entry_agent_name: 'PMAgent',
    active_agent_name: 'RuntimeAgent',
    enabled_agent_ids: ['agent-pm', 'agent-runtime'],
    participating_agents: ['PMAgent', 'RuntimeAgent'],
    max_turns: 30,
    context_summary: {
      estimated_total_tokens: 1820,
      system_chars: 3200,
      user_chars: 148,
      memory_chars: 0,
    },
    timeline: [
      {
        event_type: 'prompt_snapshot',
        title: 'Prompt sent to PMAgent',
        body: 'System instructions, memory policy, and user request.',
      },
      {
        event_type: 'tool_call',
        title: 'RuntimeAgent local command',
        body: 'ls -lah ~/Desktop | head -5',
      },
      {
        event_type: 'tool_result',
        title: 'RuntimeAgent local command result',
        body: '$RECYCLE.BIN\nOpenClaw橙皮书-从入门到精通.pdf\nOld_Homebrew',
      },
    ],
    file_changes: [
      {
        path: '/Users/ding/zdcode/zdcode-cli/python_runtime/app.py',
        operation: 'updated',
        tool: 'apply_patch',
      },
      {
        path: '/Users/ding/zdcode/zdcode-cli/dashboard/src/features/tasks/components/task-detail.tsx',
        operation: 'updated',
        tool: 'write_local_file',
      },
    ],
  },
  {
    id: 'task-2',
    title: 'Prompt audit',
    prompt: 'Open the latest run and estimate the prompt budget before shipping.',
    status: 'running',
    entry_agent_id: 'agent-runtime',
    entry_agent_name: 'RuntimeAgent',
    active_agent_name: 'RuntimeAgent',
    enabled_agent_ids: ['agent-runtime'],
    participating_agents: ['RuntimeAgent'],
    max_turns: 24,
    context_summary: {
      estimated_total_tokens: 960,
      system_chars: 1840,
      user_chars: 92,
      memory_chars: 0,
    },
    timeline: [
      {
        event_type: 'run_started',
        title: 'Orchestrator started',
        body: 'RuntimeAgent is collecting trace detail.',
      },
    ],
  },
]

export const mockChannelConnections: ChannelConnection[] = [
  {
    id: 'feishu-main',
    name: 'Feishu Main',
    provider: 'feishu',
    enabled: true,
    app_id: 'cli_mock_xxx',
    app_secret: 'secret_mock_xxx',
    domain: 'feishu',
    webhook: '',
  },
]

export const mockChannelBindings: ChannelBinding[] = [
  {
    id: 'binding-demo-1',
    agent_id: 'demo-orchestrator',
    agent_name: 'DemoOrchestrator',
    provider: 'feishu',
    connection_id: 'feishu-main',
    conversation_id: 'oc_demo_chat',
    enabled_agent_ids: ['demo-orchestrator', 'repo-reader'],
    max_turns: 30,
    push_enabled: true,
    enabled: true,
  },
]
