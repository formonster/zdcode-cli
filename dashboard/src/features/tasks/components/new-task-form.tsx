import { useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from '@tanstack/react-form'
import { ArrowUp, Plus } from 'lucide-react'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { createTask } from '@/features/tasks/api/dashboard-api'
import type { AgentProfile } from '@/shared/types/runtime'

type Props = {
  agents: AgentProfile[]
}

export function NewTaskForm({ agents }: Props) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: createTask,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })

  const form = useForm({
    defaultValues: {
      prompt: '',
      max_turns: 30,
      entry_agent_id: agents[0]?.id ?? '',
      enabled_agent_ids: agents.slice(1, 3).map((agent) => agent.id),
    },
    onSubmit: async ({ value }) => {
      const enabled = Array.from(new Set([value.entry_agent_id, ...value.enabled_agent_ids]))
      await mutation.mutateAsync({
        prompt: value.prompt,
        entry_agent_id: value.entry_agent_id,
        enabled_agent_ids: enabled,
        max_turns: value.max_turns,
      })
      form.reset()
    },
  })

  useEffect(() => {
    if (!form.state.values.entry_agent_id && agents[0]?.id) {
      form.setFieldValue('entry_agent_id', agents[0].id)
    }
  }, [agents, form])

  return (
    <div className="flex h-full flex-col">
      <Card className="flex h-full flex-col rounded-[26px] bg-white/[0.03] p-4">
        <CardHeader className="pb-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.26em] text-muted-foreground">New task</p>
            <CardTitle className="mt-1 text-xl">Start from a prompt</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void form.handleSubmit()
            }}
          >
            <form.Field
              name="prompt"
              children={(field) => (
                <Textarea
                  rows={14}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  className="min-h-0 flex-1 rounded-[24px] border-white/8 bg-background/40 text-[15px] leading-7"
                  placeholder="Describe the task. The right panel stays focused on the work thread, while the controls for lead agent, support agents, and turn budget stay tucked into the lower rail."
                />
              )}
            />

            <div className="mt-3 rounded-[24px] border border-white/8 bg-background/60 p-3">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-muted-foreground">
                  <Plus className="size-3.5" />
                  Runtime controls
                </div>
                <form.Field
                  name="max_turns"
                  children={(field) => (
                    <input
                      type="number"
                      min={1}
                      value={String(field.state.value)}
                      onChange={(event) => field.handleChange(Number(event.target.value))}
                      className="h-8 w-16 rounded-full border border-white/8 bg-white/[0.04] px-3 text-center text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                    />
                  )}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <form.Field
                  name="entry_agent_id"
                  children={(field) => (
                    <>
                      <button
                        type="button"
                        className="rounded-full border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs text-accent"
                        onClick={() => field.handleChange(field.state.value)}
                      >
                        Lead
                      </button>
                      {agents.map((agent) => {
                        const selected = field.state.value === agent.id
                        return (
                          <button
                            key={agent.id}
                            type="button"
                            onClick={() => field.handleChange(agent.id)}
                            className={`flex items-center gap-2 rounded-full border px-2 py-1.5 text-xs ${
                              selected ? 'border-white/20 bg-white/10 text-foreground' : 'border-white/8 bg-white/[0.03] text-muted-foreground'
                            }`}
                          >
                            <Avatar className="size-6">
                              <AvatarFallback>{agent.name.slice(0, 1)}</AvatarFallback>
                            </Avatar>
                            {agent.name}
                          </button>
                        )
                      })}
                    </>
                  )}
                />
              </div>

              <form.Field
                name="enabled_agent_ids"
                children={(field) => (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Support</span>
                    {agents.map((agent) => {
                      const selected = field.state.value.includes(agent.id)
                      return (
                        <button
                          key={agent.id}
                          type="button"
                          onClick={() =>
                            field.handleChange(
                              selected ? field.state.value.filter((item) => item !== agent.id) : [...field.state.value, agent.id],
                            )
                          }
                          className={`rounded-full border px-3 py-1.5 text-xs ${
                            selected ? 'border-accent/40 bg-accent/10 text-accent' : 'border-white/8 bg-white/[0.03] text-muted-foreground'
                          }`}
                        >
                          {agent.name}
                        </button>
                      )
                    })}
                  </div>
                )}
              />
            </div>

            <div className="mt-3 flex justify-end">
              <Button type="submit" variant="accent" className="size-11 rounded-full p-0">
                <ArrowUp className="size-4" />
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
