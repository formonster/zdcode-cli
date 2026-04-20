import { useMemo } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import {
  Activity,
  ArrowUp,
  Bot,
  ChevronDown,
  Circle,
  FolderTree,
  Scissors,
  Square,
  TerminalSquare,
  Trash2,
} from 'lucide-react'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useDashboardStore } from '@/features/dashboard/store/dashboard-store'
import { cancelTask, compressTaskContext, deleteTask, sendTaskMessage } from '@/features/tasks/api/dashboard-api'
import { useAutoScroll } from '@/shared/hooks/use-auto-scroll'
import type { TaskFileChange, TaskSession, TimelineEvent } from '@/shared/types/runtime'
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'

type TimelineRow =
  | { type: 'event'; key: string; event: TimelineEvent }
  | { type: 'tool-group'; key: string; events: TimelineEvent[]; summary: string }

function pluralize(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function eventColor(eventType: string) {
  if (eventType.includes('tool')) return 'border-cyan-400/20 bg-cyan-400/6'
  if (eventType.includes('prompt')) return 'border-emerald-400/20 bg-emerald-400/6'
  return 'border-white/8 bg-white/[0.03]'
}

function isToolEvent(event: TimelineEvent) {
  return event.event_type === 'tool_call' || event.event_type === 'tool_result'
}

function summarizeToolEvents(events: TimelineEvent[]) {
  const edited = new Set<string>()
  const explored = new Set<string>()
  let commands = 0
  let browserSteps = 0

  for (const event of events) {
    const payload = event.payload ?? {}
    const tool = String(payload.tool ?? '')
    const path = String(payload.path ?? '')
    if (tool === 'apply_patch' || tool === 'write_local_file') {
      if (path) edited.add(path)
    } else if (tool === 'read_local_file' || tool === 'list_local_files') {
      if (path) explored.add(path)
    } else if (tool === 'shell' || tool === 'run_local_command') {
      commands += event.event_type === 'tool_call' ? 1 : 0
    } else if (tool === 'computer') {
      browserSteps += event.event_type === 'tool_call' ? 1 : 0
    }
  }

  const parts: string[] = []
  if (edited.size) parts.push(`Edited ${pluralize(edited.size, 'file')}`)
  if (explored.size) parts.push(`Explored ${pluralize(explored.size, 'file')}`)
  if (commands) parts.push(`Ran ${pluralize(commands, 'command')}`)
  if (browserSteps) parts.push(`Browser ${pluralize(browserSteps, 'step')}`)

  if (!parts.length) {
    const calls = events.filter((event) => event.event_type === 'tool_call').length
    parts.push(`Used tools ${pluralize(calls || events.length, 'time')}`)
  }

  return parts.join(', ')
}

function buildTimelineRows(timeline: TimelineEvent[]) {
  const rows: TimelineRow[] = []

  for (let index = 0; index < timeline.length; index += 1) {
    const event = timeline[index]
    if (!isToolEvent(event)) {
      rows.push({ type: 'event', key: `event-${index}`, event })
      continue
    }

    const group: TimelineEvent[] = [event]
    let cursor = index + 1
    while (cursor < timeline.length && isToolEvent(timeline[cursor])) {
      group.push(timeline[cursor])
      cursor += 1
    }

    rows.push({
      type: 'tool-group',
      key: `tool-group-${index}`,
      events: group,
      summary: summarizeToolEvents(group),
    })
    index = cursor - 1
  }

  return rows
}

function changeVariant(operation: TaskFileChange['operation']) {
  if (operation === 'created') return 'success'
  if (operation === 'deleted') return 'danger'
  return 'default'
}

function ContextUsageRing({
  estimatedTokens,
  contextWindow,
  usagePercent,
}: {
  estimatedTokens: number
  contextWindow: number
  usagePercent: number
}) {
  const size = 26
  const stroke = 2.5
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const progress = Math.max(0, Math.min(usagePercent, 1))
  const dashOffset = circumference * (1 - progress)
  const ringClass =
    progress >= 0.95 ? 'text-rose-400' : progress >= 0.8 ? 'text-amber-400' : 'text-emerald-400'

  return (
    <div className="group relative">
      <div className="flex h-8 w-8 items-center justify-center rounded-full border border-white/8 bg-white/[0.03]">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={stroke}
            className="text-white/8"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={contextWindow > 0 ? dashOffset : circumference}
            className={ringClass}
          />
        </svg>
      </div>
      <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden w-max -translate-x-1/2 rounded-xl border border-white/8 bg-black/90 px-3 py-2 text-[11px] text-slate-200 shadow-2xl group-hover:block">
        <div className="font-mono uppercase tracking-[0.18em] text-muted-foreground">Context</div>
        <div className="mt-1">{estimatedTokens} tokens</div>
        <div>{contextWindow > 0 ? `${(progress * 100).toFixed(1)}% of ${contextWindow}` : 'Window unknown'}</div>
      </div>
    </div>
  )
}

function PromptSnapshotCard({ event, compact = false }: { event: TimelineEvent; compact?: boolean }) {
  const payload = event.payload ?? {}
  const finalSystemPrompt = typeof payload.final_system_prompt === 'string' ? payload.final_system_prompt : ''
  const userInput = typeof payload.user_input === 'string' ? payload.user_input : ''
  const contextSummary = payload.context_summary && typeof payload.context_summary === 'object' ? payload.context_summary : null
  const estimatedTokens =
    contextSummary && 'estimated_total_tokens' in contextSummary ? Number(contextSummary.estimated_total_tokens ?? 0) : 0
  const contextWindow =
    contextSummary && 'context_window' in contextSummary ? Number(contextSummary.context_window ?? 0) : 0
  const usagePercent =
    contextSummary && 'context_usage_percent' in contextSummary ? Number(contextSummary.context_usage_percent ?? 0) : 0

  return (
    <details className={`group rounded-[18px] border border-emerald-400/20 bg-emerald-400/6 ${compact ? 'p-0' : 'p-0'}`}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 marker:hidden">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">{event.event_type}</p>
          <h4 className="mt-1 truncate text-[13px] font-medium text-foreground">{event.title}</h4>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {estimatedTokens > 0 ? <span>{estimatedTokens} tokens</span> : null}
            {contextWindow > 0 ? <span>{`${(usagePercent * 100).toFixed(1)}% of ${contextWindow}`}</span> : null}
            {typeof payload.model_key === 'string' && payload.model_key ? <span className="truncate">{payload.model_key}</span> : null}
          </div>
        </div>
        <ChevronDown className="size-4 shrink-0 transition-transform duration-200 group-open:rotate-180" />
      </summary>
      <div className="space-y-3 border-t border-white/8 px-3 pb-3 pt-3">
        {event.body ? (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-2xl bg-black/20 p-3 font-mono text-[11px] leading-5 text-slate-200">
            {event.body}
          </pre>
        ) : null}
        {userInput ? (
          <div>
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">User Input</p>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-2xl bg-black/20 p-3 font-mono text-[11px] leading-5 text-slate-200">
              {userInput}
            </pre>
          </div>
        ) : null}
        {finalSystemPrompt ? (
          <div>
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">Final System Prompt</p>
            <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-2xl bg-black/20 p-3 font-mono text-[11px] leading-5 text-slate-200">
              {finalSystemPrompt}
            </pre>
          </div>
        ) : null}
      </div>
    </details>
  )
}

function TimelineEventCard({ event, index, compact = false }: { event: TimelineEvent; index: number; compact?: boolean }) {
  if (event.event_type === 'prompt_snapshot') {
    return <PromptSnapshotCard event={event} compact={compact} />
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: compact ? 0 : 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: compact ? 0 : index * 0.025 }}
      className={`rounded-[18px] border ${compact ? 'p-2.5' : 'p-3'} ${eventColor(event.event_type)}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <div className="rounded-full border border-white/10 bg-background/60 p-1.5">
          <Circle className="size-2.5 fill-current text-accent" />
        </div>
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">{event.event_type}</p>
          <h4 className="truncate text-[13px] font-medium">{event.title}</h4>
        </div>
      </div>
      {event.body ? (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-2xl bg-black/20 p-3 font-mono text-[11px] leading-5 text-slate-200">
          {event.body}
        </pre>
      ) : null}
    </motion.div>
  )
}

function ToolGroupCard({ events, summary }: { events: TimelineEvent[]; summary: string }) {
  return (
    <details className="group rounded-[18px] border border-white/8 bg-white/[0.03] open:border-cyan-400/20 open:bg-cyan-400/6">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 marker:hidden">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">Tool activity</p>
          <h4 className="mt-1 text-[13px] font-medium text-foreground">{summary}</h4>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{pluralize(events.length, 'event')}</span>
          <ChevronDown className="size-4 transition-transform duration-200 group-open:rotate-180" />
        </div>
      </summary>
      <div className="space-y-2 border-t border-white/8 px-3 pb-3 pt-2">
        {events.map((event, index) => (
          <TimelineEventCard key={`${event.event_type}-${index}-${event.title}`} event={event} index={index} compact />
        ))}
      </div>
    </details>
  )
}

function FileChangesCard({ fileChanges }: { fileChanges: TaskFileChange[] }) {
  if (!fileChanges.length) return null

  return (
    <div className="rounded-[20px] border border-white/8 bg-white/[0.03] p-3">
      <div className="mb-3 flex items-center gap-2">
        <FolderTree className="size-4 text-accent" />
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">Files changed</p>
          <h4 className="text-sm font-medium">{pluralize(fileChanges.length, 'file')} changed</h4>
        </div>
      </div>
      <div className="space-y-2">
        {fileChanges.map((change) => (
          <div key={`${change.path}-${change.operation}`} className="flex items-center justify-between gap-3 rounded-[16px] border border-white/8 bg-black/10 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm text-foreground">{change.path.split('/').pop()}</p>
              <p className="truncate text-xs text-muted-foreground">{change.path}</p>
            </div>
            <Badge variant={changeVariant(change.operation) as never}>{change.operation}</Badge>
          </div>
        ))}
      </div>
    </div>
  )
}

type Props = {
  task?: TaskSession
}

export function TaskDetail({ task }: Props) {
  const composerValue = useDashboardStore((state) => state.composerValue)
  const setComposerValue = useDashboardStore((state) => state.setComposerValue)
  const setSelection = useDashboardStore((state) => state.setSelection)
  const queryClient = useQueryClient()

  const timelineLength = task?.timeline?.length ?? 0
  const { containerRef, handleScroll } = useAutoScroll(timelineLength)

  const timelineRows = useMemo(() => buildTimelineRows(task?.timeline ?? []), [task?.timeline])
  const estimatedTokens = task?.context_summary?.estimated_total_tokens ?? 0
  const contextWindow = task?.context_summary?.context_window ?? 0
  const usagePercent = Math.max(0, Math.min(task?.context_summary?.context_usage_percent ?? 0, 1))

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

  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!task) return null
      return cancelTask(task.id)
    },
    onSuccess: async () => {
      if (task) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['tasks'] }),
          queryClient.invalidateQueries({ queryKey: ['task', task.id] }),
        ])
      }
    },
  })

  const compressMutation = useMutation({
    mutationFn: async () => {
      if (!task) return task
      return compressTaskContext(task.id)
    },
    onSuccess: async () => {
      if (task) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['tasks'] }),
          queryClient.invalidateQueries({ queryKey: ['task', task.id] }),
        ])
      }
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!task) return null
      return deleteTask(task.id)
    },
    onSuccess: async () => {
      setComposerValue('')
      setSelection({ type: 'new-task' })
      await queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (composerValue.trim() && !messageMutation.isPending) {
        void messageMutation.mutateAsync()
      }
    }
  }

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

  const canSend = task.status !== 'running' && task.status !== 'waiting_approval'
  const canCancel = task.status === 'running' || task.status === 'waiting_approval'
  const canCompress = !canCancel && Boolean(task.timeline?.length)
  const canDelete = !canCancel && !deleteMutation.isPending

  return (
    <div className="panel-surface codex-grid flex h-[calc(100vh-24px)] flex-col rounded-[28px] p-3">
      <div className="min-h-0 flex-1 overflow-hidden rounded-[24px] border border-white/8 bg-black/10">
        <ScrollAreaPrimitive.Root className="relative h-full overflow-hidden pr-2">
          <ScrollAreaPrimitive.Viewport ref={containerRef} onScroll={handleScroll} className="size-full rounded-[inherit]">
            <div className="space-y-2 p-3">
              {timelineRows.map((row, index) =>
                row.type === 'tool-group' ? (
                  <ToolGroupCard key={row.key} events={row.events} summary={row.summary} />
                ) : (
                  <TimelineEventCard key={row.key} event={row.event} index={index} />
                ),
              )}
              {task.status === 'completed' ? <FileChangesCard fileChanges={task.file_changes ?? []} /> : null}
            </div>
          </ScrollAreaPrimitive.Viewport>
          <ScrollAreaPrimitive.Scrollbar orientation="vertical" className="flex w-2.5 touch-none p-[1px] transition-colors">
            <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-white/12" />
          </ScrollAreaPrimitive.Scrollbar>
          <ScrollAreaPrimitive.Corner />
        </ScrollAreaPrimitive.Root>
      </div>

      <div className="mt-3 rounded-[24px] border border-white/8 bg-background/85 p-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">Task thread</p>
            <p className="mt-1 line-clamp-2 text-sm font-medium leading-6 text-foreground/90">{task.prompt}</p>
          </div>
          <Badge variant={task.status === 'completed' ? 'success' : task.status === 'running' ? 'warning' : task.status === 'failed' ? 'danger' : 'default'}>
            {task.status}
          </Badge>
        </div>
        <textarea
          value={composerValue}
          onChange={(event) => setComposerValue(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={4}
          className="w-full resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-muted-foreground"
          placeholder="Continue this task... (Enter to send, Shift+Enter for new line)"
          disabled={!canSend}
        />
        <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <ContextUsageRing estimatedTokens={estimatedTokens} contextWindow={contextWindow} usagePercent={usagePercent} />
            <div className="flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5">
              <Scissors className="size-3.5" />
              <span>{task.compression_count ?? 0}</span>
            </div>
            <div className="flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5">
              <Activity className="size-3.5" />
              <span>{task.max_turns}</span>
            </div>
            <div className="flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5">
              <Bot className="size-3.5" />
              <span className="max-w-[180px] truncate">{task.entry_agent_name}</span>
            </div>
            {task.context_summary?.model_key ? (
              <div className="flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5">
                <Bot className="size-3.5" />
                <span className="max-w-[220px] truncate">{task.context_summary.model_key}</span>
              </div>
            ) : null}
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
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={!canCompress || compressMutation.isPending}
              onClick={() => void compressMutation.mutateAsync()}
            >
              <Scissors className="mr-2 size-3.5" />
              Compress
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!canCancel || cancelMutation.isPending}
              onClick={() => void cancelMutation.mutateAsync()}
            >
              <Square className="mr-2 size-3.5" />
              Terminate
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
              disabled={!canDelete}
              onClick={() => void deleteMutation.mutateAsync()}
            >
              <Trash2 className="mr-2 size-3.5" />
              Delete
            </Button>
            <Button
              size="icon"
              variant="accent"
              className="size-10 rounded-full"
              disabled={!canSend || !composerValue.trim() || messageMutation.isPending}
              onClick={() => void messageMutation.mutateAsync()}
            >
              <ArrowUp className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
