export type RuntimeHealth = {
  ok: boolean
  status: string
  runtime: {
    agentsAvailable: boolean
    memoryEnabled: boolean
    defaultModel: string
    openAIApiKey: boolean
  }
}

export type AppSettings = {
  global_system_prompt: string
}

export type SkillRecord = {
  id: string
  name: string
  description: string
  path: string
}

export type ModelRecord = {
  model_key: string
  provider: string
  display_name: string
  alias?: string
  is_default?: boolean
}

export type AgentProfile = {
  id: string
  name: string
  description: string
  avatar_url?: string
  persona_prompt: string
  skills_prompt: string
  agent_identity_prompt: string
  agent_responsibility_prompt: string
  agent_non_goals_prompt: string
  selected_skills: string[]
  default_model: string
  workspace_binding: string
  channel_config?: {
    provider?: string
    app_id?: string
    app_secret?: string
    domain?: string
    webhook?: string
    chat_id?: string
    push_enabled?: boolean
    enabled?: boolean
  }
  enabled: boolean
}

export type ChannelConnection = {
  id: string
  name: string
  provider: string
  enabled: boolean
  app_id: string
  app_secret: string
  domain: string
  webhook: string
  created_at?: string
  updated_at?: string
}

export type ChannelBinding = {
  id: string
  agent_id: string
  agent_name: string
  provider: string
  connection_id: string
  conversation_id: string
  enabled_agent_ids: string[]
  max_turns: number
  push_enabled: boolean
  enabled: boolean
  created_at?: string
  updated_at?: string
}

export type TimelineEvent = {
  id?: number
  event_type: string
  title: string
  body?: string
  payload?: Record<string, unknown>
  created_at?: string
}

export type TaskFileChange = {
  path: string
  operation: 'created' | 'updated' | 'deleted'
  tool?: string
}

export type TaskSession = {
  id: string
  title: string
  prompt: string
  status: string
  entry_agent_id: string
  entry_agent_name?: string
  active_agent_name?: string
  enabled_agent_ids: string[]
  participating_agents: string[]
  max_turns: number
  context_summary?: {
    estimated_total_tokens?: number
    system_chars?: number
    user_chars?: number
    compressed_chars?: number
    memory_chars?: number
    context_window?: number
    context_usage_percent?: number
    model_key?: string
  }
  compressed_context?: string
  compression_count?: number
  timeline?: TimelineEvent[]
  file_changes?: TaskFileChange[]
}
