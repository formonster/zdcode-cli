import { useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { ChevronRight, Sparkles, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useDashboardStore } from '@/features/dashboard/store/dashboard-store'
import { deleteTask } from '@/features/tasks/api/dashboard-api'
import { cn } from '@/shared/lib/utils'
import type { TaskSession } from '@/shared/types/runtime'

type Props = {
  tasks: TaskSession[]
}

function statusVariant(status: string) {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'running') return 'warning'
  return 'default'
}

export function TaskList({ tasks }: Props) {
  const selection = useDashboardStore((state) => state.selection)
  const setSelection = useDashboardStore((state) => state.setSelection)
  const queryClient = useQueryClient()

  const deleteMutation = useMutation({
    mutationFn: deleteTask,
    onSuccess: async (_, taskId) => {
      if (selection.type === 'task' && selection.id === taskId) {
        setSelection({ type: 'new-task' })
      }
      await queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })

  return (
    <ScrollArea className="h-[calc(100vh-360px)] pr-2">
      <div className="space-y-1.5">
        {tasks.map((task, index) => {
          const selected = selection.type === 'task' && selection.id === task.id
          return (
            <motion.div
              key={task.id}
              layout
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.02 }}
              role="button"
              tabIndex={0}
              onClick={() => setSelection({ type: 'task', id: task.id })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setSelection({ type: 'task', id: task.id })
                }
              }}
              className={cn(
                'w-full rounded-[18px] border px-3 py-2 text-left transition',
                selected ? 'border-accent/40 bg-accent/8' : 'border-white/8 bg-white/[0.02] hover:bg-white/[0.05]',
              )}
            >
              <div className="flex items-start gap-2">
                <Sparkles className="mt-0.5 size-3.5 shrink-0 text-accent" />
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-[13px] leading-5 text-foreground">{task.prompt}</p>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <Badge variant={statusVariant(task.status) as never}>{task.status}</Badge>
                    <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                      <span>{task.max_turns}</span>
                      {task.status !== 'running' && task.status !== 'waiting_approval' ? (
                        <button
                          type="button"
                          className="rounded-full p-1 hover:bg-rose-500/10 hover:text-rose-300"
                          onClick={(event) => {
                            event.stopPropagation()
                            void deleteMutation.mutateAsync(task.id)
                          }}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      ) : null}
                      <ChevronRight className="size-3.5" />
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )
        })}
      </div>
    </ScrollArea>
  )
}
