import { runtimeFetch } from '@/shared/api/runtime-client'
import type { AgentProfile, ModelRecord, RuntimeHealth, SkillRecord, TaskSession } from '@/shared/types/runtime'

import { mockAgents, mockHealth, mockModels, mockSkills, mockTasks } from '../lib/mock-data'

async function fallback<T>(request: Promise<T>, substitute: T): Promise<T> {
  try {
    return await request
  } catch {
    return substitute
  }
}

export function getHealth() {
  return fallback(runtimeFetch<RuntimeHealth>('/health'), mockHealth)
}

export function getAgents() {
  return fallback(runtimeFetch<AgentProfile[]>('/agents'), mockAgents)
}

export function getAgent(agentId: string) {
  return fallback(runtimeFetch<AgentProfile>(`/agents/${agentId}`), mockAgents.find((agent) => agent.id === agentId) ?? mockAgents[0])
}

export function getTasks() {
  return fallback(runtimeFetch<TaskSession[]>('/tasks'), mockTasks)
}

export function getTask(taskId: string) {
  return fallback(runtimeFetch<TaskSession>(`/tasks/${taskId}`), mockTasks.find((task) => task.id === taskId) ?? mockTasks[0])
}

export function getSkills() {
  return fallback(runtimeFetch<SkillRecord[]>('/skills'), mockSkills)
}

export function getModels() {
  return fallback(runtimeFetch<ModelRecord[]>('/models'), mockModels)
}

export function createTask(payload: {
  prompt: string
  entry_agent_id: string
  enabled_agent_ids: string[]
  max_turns: number
}) {
  return runtimeFetch<TaskSession>('/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: payload.prompt.slice(0, 48),
      ...payload,
    }),
  })
}

export function sendTaskMessage(taskId: string, prompt: string) {
  return runtimeFetch<TaskSession>(`/tasks/${taskId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  })
}

export function createAgent(payload: Partial<AgentProfile> & Pick<AgentProfile, 'name' | 'default_model' | 'workspace_binding'>) {
  return runtimeFetch<AgentProfile>('/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: payload.name,
      description: payload.description ?? '',
      avatar_url: payload.avatar_url ?? '',
      default_model: payload.default_model,
      workspace_binding: payload.workspace_binding,
      persona_prompt: payload.persona_prompt ?? '',
      skills_prompt: payload.skills_prompt ?? '',
      selected_skills: payload.selected_skills ?? [],
      tool_profile: {
        shell: true,
        filesystem: true,
        browser: false,
      },
      memory_policy: {
        provider: 'mem0',
        scope: payload.name,
      },
      enabled: payload.enabled ?? true,
    }),
  })
}

export function updateAgent(agentId: string, payload: Partial<AgentProfile>) {
  return runtimeFetch<AgentProfile>(`/agents/${agentId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}
