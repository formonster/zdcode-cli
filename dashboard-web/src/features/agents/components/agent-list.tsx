import { Bot, Plus } from 'lucide-react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useDashboardStore } from '@/features/dashboard/store/dashboard-store'
import type { AgentProfile } from '@/shared/types/runtime'

type Props = {
  agents: AgentProfile[]
}

export function AgentList({ agents }: Props) {
  const selection = useDashboardStore((state) => state.selection)
  const setSelection = useDashboardStore((state) => state.setSelection)
  const openNewAgentModal = useDashboardStore((state) => state.openNewAgentModal)

  return (
    <div className="flex min-h-0 flex-col">
      <ScrollArea className="h-[280px] pr-2">
        <div className="space-y-1.5">
          {agents.map((agent) => {
            const selected = selection.type === 'agent' && selection.id === agent.id
            return (
              <button
                key={agent.id}
                onClick={() => setSelection({ type: 'agent', id: agent.id })}
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
              </button>
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
