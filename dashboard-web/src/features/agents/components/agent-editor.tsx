import { useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from '@tanstack/react-form'
import { Bot, ImagePlus, Sparkles } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { createAgent, updateAgent } from '@/features/tasks/api/dashboard-api'
import type { AgentProfile, ModelRecord, SkillRecord } from '@/shared/types/runtime'

type Props = {
  agent?: AgentProfile
  models: ModelRecord[]
  skills: SkillRecord[]
  mode: 'create' | 'edit'
  onDone?: () => void
}

export function AgentEditor({ agent, models, skills, mode, onDone }: Props) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (value: AgentProfile) => {
      if (mode === 'edit' && agent) {
        return updateAgent(agent.id, value)
      }
      return createAgent(value)
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['agents'] }),
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      ])
      onDone?.()
    },
  })

  const form = useForm({
    defaultValues: {
      name: agent?.name ?? '',
      description: agent?.description ?? '',
      avatar_url: agent?.avatar_url ?? '',
      default_model: agent?.default_model ?? models.find((item) => item.is_default)?.model_key ?? '',
      persona_prompt: agent?.persona_prompt ?? '',
      skills_prompt: agent?.skills_prompt ?? '',
      selected_skills: agent?.selected_skills ?? [],
      workspace_binding: agent?.workspace_binding ?? '/Users/ding/zdcode/zdcode-cli',
      enabled: agent?.enabled ?? true,
    },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(value as AgentProfile)
    },
  })

  useEffect(() => {
    form.reset({
      name: agent?.name ?? '',
      description: agent?.description ?? '',
      avatar_url: agent?.avatar_url ?? '',
      default_model: agent?.default_model ?? models.find((item) => item.is_default)?.model_key ?? '',
      persona_prompt: agent?.persona_prompt ?? '',
      skills_prompt: agent?.skills_prompt ?? '',
      selected_skills: agent?.selected_skills ?? [],
      workspace_binding: agent?.workspace_binding ?? '/Users/ding/zdcode/zdcode-cli',
      enabled: agent?.enabled ?? true,
    })
  }, [agent, form, mode, models])

  return (
    <div className="flex h-full flex-col gap-3">
      <Card className="flex h-full min-h-0 flex-col rounded-[24px] bg-white/[0.03] p-4">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-3">
            <div className="flex size-12 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
              <Bot className="size-5 text-accent" />
            </div>
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.26em] text-muted-foreground">{mode === 'create' ? 'New agent' : 'Agent detail'}</p>
              <CardTitle className="mt-1 text-xl">{mode === 'create' ? 'Create an agent' : agent?.name ?? 'Agent'}</CardTitle>
            </div>
          </div>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 p-0">
          <form
            className="flex h-full min-h-0 flex-col"
            onSubmit={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void form.handleSubmit()
            }}
          >
            <ScrollArea className="min-h-0 flex-1 pr-2">
              <div className="space-y-3">
                <div className="grid grid-cols-[88px_1fr] gap-3">
                  <form.Field
                    name="avatar_url"
                    children={(field) => (
                      <button type="button" className="flex h-[88px] items-center justify-center rounded-[20px] border border-dashed border-white/10 bg-white/[0.03] text-muted-foreground">
                        {field.state.value ? (
                          <img src={field.state.value} alt="agent avatar" className="h-full w-full rounded-[20px] object-cover" />
                        ) : (
                          <ImagePlus className="size-5" />
                        )}
                      </button>
                    )}
                  />
                  <div className="grid gap-3">
                    <form.Field
                      name="name"
                      children={(field) => <Input value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} placeholder="RuntimeAgent" />}
                    />
                    <form.Field
                      name="default_model"
                      children={(field) => (
                        <select
                          className="flex h-11 w-full rounded-2xl border border-white/8 bg-white/4 px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                          value={field.state.value}
                          onChange={(event) => field.handleChange(event.target.value)}
                        >
                          {models.map((model) => (
                            <option key={model.model_key} value={model.model_key} className="bg-card text-foreground">
                              {model.alias || model.display_name}
                            </option>
                          ))}
                        </select>
                      )}
                    />
                  </div>
                </div>

                <form.Field
                  name="description"
                  children={(field) => <Input value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} placeholder="Short responsibility summary" />}
                />

                <form.Field
                  name="persona_prompt"
                  children={(field) => (
                    <Textarea
                      rows={6}
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.target.value)}
                      placeholder="Define the agent's responsibility prompt."
                    />
                  )}
                />

                <form.Field
                  name="skills_prompt"
                  children={(field) => (
                    <Textarea
                      rows={4}
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.target.value)}
                      placeholder="Any extra operational guidance."
                    />
                  )}
                />

                <form.Field
                  name="selected_skills"
                  children={(field) => (
                    <div className="rounded-[20px] border border-white/8 bg-black/10 p-3">
                      <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-muted-foreground">
                        <Sparkles className="size-3.5" />
                        Skills
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {skills.map((skill) => {
                          const selected = field.state.value.includes(skill.id)
                          return (
                            <button
                              key={skill.id}
                              type="button"
                              onClick={() =>
                                field.handleChange(
                                  selected
                                    ? field.state.value.filter((item) => item !== skill.id)
                                    : [...field.state.value, skill.id],
                                )
                              }
                              className={`rounded-full border px-3 py-1.5 text-xs transition ${
                                selected ? 'border-accent/40 bg-accent/10 text-accent' : 'border-white/10 bg-white/[0.03] text-muted-foreground'
                              }`}
                              title={skill.description}
                            >
                              {skill.name}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}
                />
              </div>
            </ScrollArea>

            <div className="mt-3 flex items-center justify-between gap-3">
              <Badge variant={form.state.values.enabled ? 'success' : 'danger'}>{form.state.values.enabled ? 'enabled' : 'disabled'}</Badge>
              <div className="flex gap-2">
                {onDone ? (
                  <Button type="button" variant="ghost" className="h-10 px-4" onClick={onDone}>
                    Cancel
                  </Button>
                ) : null}
                <Button type="submit" variant="accent" className="h-10 px-4">
                  {mode === 'create' ? 'Create Agent' : 'Save Agent'}
                </Button>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
