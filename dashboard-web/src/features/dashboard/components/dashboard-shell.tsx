import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Command, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { AgentEditor } from '@/features/agents/components/agent-editor'
import { AgentList } from '@/features/agents/components/agent-list'
import { useDashboardStore } from '@/features/dashboard/store/dashboard-store'
import { getAgent, getAgents, getHealth, getModels, getSkills, getTask, getTasks } from '@/features/tasks/api/dashboard-api'
import { NewTaskForm } from '@/features/tasks/components/new-task-form'
import { TaskDetail } from '@/features/tasks/components/task-detail'
import { TaskList } from '@/features/tasks/components/task-list'

function SectionHeader({
  title,
  count,
  open,
  onToggle,
}: {
  title: string
  count: number
  open: boolean
  onToggle: () => void
}) {
  return (
    <button onClick={onToggle} className="flex w-full items-center justify-between rounded-[16px] px-2 py-2 text-left hover:bg-white/[0.04]">
      <div className="flex items-center gap-2">
        {open ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
        <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-foreground">{title}</span>
      </div>
      <span className="text-xs text-muted-foreground">{count}</span>
    </button>
  )
}

export function DashboardShell() {
  const selection = useDashboardStore((state) => state.selection)
  const collapsed = useDashboardStore((state) => state.collapsed)
  const toggleSection = useDashboardStore((state) => state.toggleSection)
  const setSelection = useDashboardStore((state) => state.setSelection)
  const agentModalOpen = useDashboardStore((state) => state.agentModalOpen)
  const editingAgentId = useDashboardStore((state) => state.editingAgentId)
  const closeAgentModal = useDashboardStore((state) => state.closeAgentModal)
  const openNewAgentModal = useDashboardStore((state) => state.openNewAgentModal)

  useQuery({ queryKey: ['health'], queryFn: getHealth })
  const agentsQuery = useQuery({ queryKey: ['agents'], queryFn: getAgents })
  const tasksQuery = useQuery({ queryKey: ['tasks'], queryFn: getTasks })
  const skillsQuery = useQuery({ queryKey: ['skills'], queryFn: getSkills })
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: getModels })

  const selectedTaskId = selection.type === 'task' ? selection.id : null
  const selectedAgentId = selection.type === 'agent' ? selection.id : null

  const taskDetailQuery = useQuery({
    queryKey: ['task', selectedTaskId],
    queryFn: () => getTask(selectedTaskId!),
    enabled: Boolean(selectedTaskId),
  })

  const agentDetailQuery = useQuery({
    queryKey: ['agent', selectedAgentId],
    queryFn: () => getAgent(selectedAgentId!),
    enabled: Boolean(selectedAgentId),
  })

  const editingAgentQuery = useQuery({
    queryKey: ['agent', editingAgentId],
    queryFn: () => getAgent(editingAgentId!),
    enabled: Boolean(editingAgentId),
  })

  const agents = agentsQuery.data ?? []
  const tasks = tasksQuery.data ?? []
  const skills = skillsQuery.data ?? []
  const models = modelsQuery.data ?? []

  const rightPanel = useMemo(() => {
    if (selection.type === 'agent') {
      return <AgentEditor mode="edit" agent={agentDetailQuery.data} skills={skills} models={models} />
    }
    if (selection.type === 'task') {
      return <TaskDetail task={taskDetailQuery.data} />
    }
    return <NewTaskForm agents={agents} />
  }, [agentDetailQuery.data, agents, models, selection.type, skills, taskDetailQuery.data])

  return (
    <div className="h-screen overflow-hidden p-3">
      <div className="mx-auto grid h-full max-w-[1800px] grid-cols-[280px_minmax(0,1fr)] gap-3">
        <aside className="panel-surface flex min-h-0 flex-col rounded-[24px] p-3">
          <div className="mb-2 flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04]">
                <Command className="size-4 text-accent" />
              </div>
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.26em] text-muted-foreground">ZDCode</div>
                <div className="text-sm font-semibold">Ops Deck</div>
              </div>
            </div>
          </div>

          <Button
            variant="accent"
            className="mb-3 h-11 justify-start rounded-[18px] px-4"
            onClick={() => setSelection({ type: 'new-task' })}
          >
            <Plus className="mr-2 size-4" />
            New Task
          </Button>

          <ScrollArea className="min-h-0 flex-1 pr-1">
            <div className="space-y-2">
              <div className="rounded-[20px] border border-white/8 bg-white/[0.02] p-2">
                <SectionHeader title="Agents" count={agents.length} open={!collapsed.agents} onToggle={() => toggleSection('agents')} />
                {!collapsed.agents ? <AgentList agents={agents} /> : null}
              </div>

              <div className="rounded-[20px] border border-white/8 bg-white/[0.02] p-2">
                <SectionHeader title="Tasks" count={tasks.length} open={!collapsed.tasks} onToggle={() => toggleSection('tasks')} />
                {!collapsed.tasks ? <TaskList tasks={tasks} /> : null}
              </div>
            </div>
          </ScrollArea>
        </aside>

        <main className="min-h-0 overflow-hidden">{rightPanel}</main>
      </div>

      {agentModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-3xl">
            <AgentEditor mode={editingAgentId ? 'edit' : 'create'} agent={editingAgentQuery.data} skills={skills} models={models} onDone={closeAgentModal} />
          </div>
        </div>
      ) : null}
    </div>
  )
}
