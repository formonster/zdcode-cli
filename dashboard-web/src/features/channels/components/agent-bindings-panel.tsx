import { useMemo } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from '@tanstack/react-form'
import { Link2, MessageSquarePlus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { createChannelBinding, updateChannelBinding } from '@/features/tasks/api/dashboard-api'
import type { AgentProfile, ChannelBinding, ChannelConnection } from '@/shared/types/runtime'

type Props = {
  agent: AgentProfile
  bindings: ChannelBinding[]
  connections: ChannelConnection[]
  agents: AgentProfile[]
}

export function AgentBindingsPanel({ agent, bindings, connections, agents }: Props) {
  const queryClient = useQueryClient()
  const agentBindings = useMemo(() => bindings.filter((item) => item.agent_id === agent.id), [agent.id, bindings])

  const mutation = useMutation({
    mutationFn: async (value: {
      connection_id: string
      conversation_id: string
      enabled_agent_ids: string[]
      max_turns: number
    }) => {
      const connection = connections.find((item) => item.id === value.connection_id)
      if (!connection) {
        throw new Error('Connection not found')
      }
      return createChannelBinding({
        agent_id: agent.id,
        provider: connection.provider,
        connection_id: value.connection_id,
        conversation_id: value.conversation_id,
        enabled_agent_ids: value.enabled_agent_ids,
        max_turns: value.max_turns,
        push_enabled: true,
        enabled: true,
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['channel-bindings'] })
    },
  })

  const toggleMutation = useMutation({
    mutationFn: async ({ bindingId, enabled }: { bindingId: string; enabled: boolean }) => updateChannelBinding(bindingId, { enabled }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['channel-bindings'] })
    },
  })

  const form = useForm({
    defaultValues: {
      connection_id: connections[0]?.id ?? '',
      conversation_id: '',
      enabled_agent_ids: [agent.id],
      max_turns: 30,
    },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(value)
      form.reset({
        connection_id: connections[0]?.id ?? '',
        conversation_id: '',
        enabled_agent_ids: [agent.id],
        max_turns: 30,
      })
    },
  })

  return (
    <Card className="rounded-[24px] bg-white/[0.03] p-4">
      <CardHeader className="px-0 pb-3">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04]">
            <Link2 className="size-4 text-accent" />
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.26em] text-muted-foreground">Feishu Bindings</p>
            <CardTitle className="mt-1 text-lg">Chat entrypoints</CardTitle>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 px-0 pb-0">
        <div className="space-y-2">
          {agentBindings.map((binding) => (
            <div key={binding.id} className="flex items-center justify-between gap-3 rounded-[18px] border border-white/8 bg-black/10 px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">{binding.conversation_id}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {binding.connection_id} · {binding.max_turns} turns · {binding.push_enabled ? 'push on' : 'push off'}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                className="h-8 px-3"
                onClick={() => void toggleMutation.mutateAsync({ bindingId: binding.id, enabled: !binding.enabled })}
              >
                {binding.enabled ? 'Disable' : 'Enable'}
              </Button>
            </div>
          ))}
          {!agentBindings.length ? <div className="rounded-[18px] border border-dashed border-white/10 px-3 py-4 text-sm text-muted-foreground">No chat bindings yet.</div> : null}
        </div>

        <form
          className="space-y-3 rounded-[20px] border border-white/8 bg-black/10 p-3"
          onSubmit={(event) => {
            event.preventDefault()
            event.stopPropagation()
            void form.handleSubmit()
          }}
        >
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-muted-foreground">
            <MessageSquarePlus className="size-3.5" />
            Add chat binding
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <form.Field
              name="connection_id"
              children={(field) => (
                <select
                  className="flex h-11 w-full rounded-2xl border border-white/8 bg-white/4 px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                >
                  {connections.map((connection) => (
                    <option key={connection.id} value={connection.id} className="bg-card text-foreground">
                      {connection.name}
                    </option>
                  ))}
                </select>
              )}
            />
            <form.Field
              name="conversation_id"
              children={(field) => <Input value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} placeholder="oc_xxx / chat_id" />}
            />
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <form.Field
              name="max_turns"
              children={(field) => (
                <Input value={String(field.state.value)} onChange={(event) => field.handleChange(Number(event.target.value || 30))} placeholder="30" />
              )}
            />
            <form.Field
              name="enabled_agent_ids"
              children={(field) => (
                <div className="flex flex-wrap gap-2 rounded-[18px] border border-white/8 bg-white/[0.03] px-3 py-2">
                  {agents.map((item) => {
                    const selected = field.state.value.includes(item.id)
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`rounded-full border px-3 py-1 text-xs ${selected ? 'border-accent/40 bg-accent/10 text-accent' : 'border-white/10 text-muted-foreground'}`}
                        onClick={() =>
                          field.handleChange(
                            selected ? field.state.value.filter((value) => value !== item.id) : [...field.state.value, item.id],
                          )
                        }
                      >
                        {item.name}
                      </button>
                    )
                  })}
                </div>
              )}
            />
          </div>

          <div className="flex justify-end">
            <Button type="submit" variant="accent" className="h-10 px-4">
              Add Binding
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
