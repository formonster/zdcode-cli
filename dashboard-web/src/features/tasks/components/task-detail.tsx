import { useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { Activity, ArrowUp, Bot, Circle, Gauge, TerminalSquare } from 'lucide-react'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useDashboardStore } from '@/features/dashboard/store/dashboard-store'
import { sendTaskMessage } from '@/features/tasks/api/dashboard-api'
import type { TaskSession, TimelineEvent } from '@/shared/types/runtime'

function eventColor(eventType: string) {
  if (eventType.includes('tool')) return 'border-cyan-400/20 bg-cyan-400/6'
  if (eventType.includes('prompt')) return 'border-emerald-400/20 bg-emerald-400/6'
  return 'border-white/8 bg-white/[0.03]'
}

function TimelineItem({ event, index }: { event: TimelineEvent; index: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.025 }}
      className={`rounded-[18px] border p-3 ${eventColor(event.event_type)}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <div className="rounded-full border border-white/10 bg-background/60 p-1.5">
          <Circle className="size-2.5 fill-current text-accent" />
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">{event.event_type}</p>
          <h4 className="text-[13px] font-medium">{event.title}</h4>
        </div>
      </div>
      {event.body ? <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-2xl bg-black/20 p-3 font-mono text-[11px] leading-5 text-slate-200">{event.body}</pre> : null}
    </motion.div>
  )
}

type Props = {
  task?: TaskSession
}

export function TaskDetail({ task }: Props) {
  const composerValue = useDashboardStore((state) => state.composerValue)
  const setComposerValue = useDashboardStore((state) => state.setComposerValue)
  const queryClient = useQueryClient()

  const messageMutation = useMutation({
    mutationFn: async () => {
      if (!task || !composerValue.trim()) {
        return task
      }
      return sendTaskMessage(task.id, composerValue)
    },
    onSuccess: async () => {
      setComposerValue('')
      if (task) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['tasks'] }),
          queryClient.invalidateQueries({ queryKey: ['task', task.id] }),
        ])
      }
    },
  })

  if (!task) {
    return (
      <div className="panel-surface codex-grid flex h-[calc(100vh-24px)] items-center justify-center rounded-[28px]">
        <div className="max-w-md text-center">
          <p className="font-mono text-[10px] uppercase tracking-[0.26em] text-muted-foreground">Task thread</p>
          <h2 className="mt-2 text-2xl font-semibold">Pick a task to inspect its thread.</h2>
        </div>
      </div>
    )
  }

  return (
    <div className="panel-surface codex-grid flex h-[calc(100vh-24px)] flex-col rounded-[28px] p-3">
      <div className="min-h-0 flex-1 overflow-hidden rounded-[24px] border border-white/8 bg-black/10">
        <ScrollArea className="h-full pr-2">
          <div className="space-y-2 p-3">
            {(task.timeline ?? []).map((event, index) => (
              <TimelineItem key={`${event.event_type}-${index}`} event={event} index={index} />
            ))}
          </div>
        </ScrollArea>
      </div>

      <div className="mt-3 rounded-[24px] border border-white/8 bg-background/85 p-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">Task thread</p>
            <p className="mt-1 line-clamp-2 text-sm font-medium leading-6 text-foreground/90">{task.prompt}</p>
          </div>
          <Badge variant={task.status === 'completed' ? 'success' : task.status === 'running' ? 'warning' : 'default'}>{task.status}</Badge>
        </div>
        <textarea
          value={composerValue}
          onChange={(event) => setComposerValue(event.target.value)}
          rows={4}
          className="w-full resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-muted-foreground"
          placeholder="Continue this task..."
        />
        <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5">
              <Gauge className="size-3.5" />
              <span>{task.context_summary?.estimated_total_tokens ?? 0}</span>
            </div>
            <div className="flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5">
              <Activity className="size-3.5" />
              <span>{task.max_turns}</span>
            </div>
            <div className="flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5">
              <Bot className="size-3.5" />
              <span className="max-w-[180px] truncate">{task.entry_agent_name}</span>
            </div>
            <div className="flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.03] px-2 py-1.5">
              <TerminalSquare className="size-3.5" />
              <div className="flex -space-x-2">
                {task.participating_agents.map((name) => (
                  <Avatar key={name} className="size-7 border border-background">
                    <AvatarFallback>{name.slice(0, 1)}</AvatarFallback>
                  </Avatar>
                ))}
              </div>
            </div>
          </div>
          <Button
            size="icon"
            variant="accent"
            className="size-10 rounded-full"
            disabled={!composerValue.trim() || messageMutation.isPending}
            onClick={() => void messageMutation.mutateAsync()}
          >
            <ArrowUp className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
