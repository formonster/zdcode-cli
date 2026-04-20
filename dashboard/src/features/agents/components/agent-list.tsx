import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Bot, Plus, Trash2 } from 'lucide-react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useDashboardStore } from '@/features/dashboard/store/dashboard-store'
import { deleteAgent } from '@/features/tasks/api/dashboard-api'
import type { AgentProfile } from '@/shared/types/runtime'

type Props = {
  agents: AgentProfile[]
}

export function AgentList({ agents }: Props) {
  const selection = useDashboardStore((state) => state.selection)
  const setSelection = useDashboardStore((state) => state.setSelection)
  const openNewAgentModal = useDashboardStore((state) => state.openNewAgentModal)
  const queryClient = useQueryClient()

  const deleteMutation = useMutation({
    mutationFn: deleteAgent,
    onSuccess: async (_, agentId) => {
      if (selection.type === 'agent' && selection.id === agentId) {
        setSelection({ type: 'new-task' })
      }
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })

  return (
    <div className="flex min-h-0 flex-col">
      <ScrollArea className="max-h-[280px]">
        <div className="space-y-1.5">
          {agents.map((agent) => {
            const selected = selection.type === 'agent' && selection.id === agent.id
            return (
              <div
                key={agent.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelection({ type: 'agent', id: agent.id })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setSelection({ type: 'agent', id: agent.id })
                  }
                }}
                className={`flex w-full items-center gap-2 rounded-[18px] border px-3 py-2 text-left transition ${
                  selected ? 'border-accent/40 bg-accent/8' : 'border-white/8 bg-white/[0.02] hover:bg-white/[0.05]'
                }`}
              >
                <Avatar className="size-8">
                  <AvatarImage src={agent.avatar_url} />
                  <AvatarFallback>{agent.name.slice(0, 1)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">{agent.name}</span>
                    <Badge variant={agent.enabled ? 'success' : 'danger'}>{agent.enabled ? 'on' : 'off'}</Badge>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{agent.default_model}</p>
                </div>
                <Bot className="size-3.5 text-muted-foreground" />
                <button
                  type="button"
                  className="rounded-full p-1 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-300"
                  onClick={(event) => {
                    event.stopPropagation()
                    void deleteMutation.mutateAsync(agent.id)
                  }}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            )
          })}
        </div>
      </ScrollArea>

      <Button variant="ghost" className="mt-2 h-9 justify-start rounded-[16px] border border-dashed border-white/10 text-muted-foreground" onClick={openNewAgentModal}>
        <Plus className="mr-2 size-4" />
        New agent
      </Button>
    </div>
  )
}
