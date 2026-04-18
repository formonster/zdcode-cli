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
  selected_skills: string[]
  default_model: string
  workspace_binding: string
  enabled: boolean
}

export type TimelineEvent = {
  id?: number
  event_type: string
  title: string
  body?: string
  payload?: Record<string, unknown>
  created_at?: string
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
    memory_chars?: number
  }
  timeline?: TimelineEvent[]
}
