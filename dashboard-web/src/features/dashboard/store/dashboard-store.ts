import { produce } from 'immer'
import { create } from 'zustand'

type SidebarSection = 'agents' | 'tasks'
type Selection =
  | { type: 'new-task' }
  | { type: 'task'; id: string }
  | { type: 'agent'; id: string }

type DashboardState = {
  selection: Selection
  collapsed: Record<SidebarSection, boolean>
  composerValue: string
  agentModalOpen: boolean
  editingAgentId: string | null
  setSelection: (selection: Selection) => void
  toggleSection: (section: SidebarSection) => void
  setComposerValue: (value: string) => void
  openNewAgentModal: () => void
  openEditAgentModal: (agentId: string) => void
  closeAgentModal: () => void
}

export const useDashboardStore = create<DashboardState>()((set) => ({
  selection: { type: 'new-task' },
  collapsed: {
    agents: true,
    tasks: false,
  },
  composerValue: '',
  agentModalOpen: false,
  editingAgentId: null,
  setSelection: (selection) =>
    set((state) =>
      produce(state, (draft) => {
        draft.selection = selection
      }),
    ),
  toggleSection: (section) =>
    set((state) =>
      produce(state, (draft) => {
        draft.collapsed[section] = !draft.collapsed[section]
      }),
    ),
  setComposerValue: (value) =>
    set((state) =>
      produce(state, (draft) => {
        draft.composerValue = value
      }),
    ),
  openNewAgentModal: () =>
    set((state) =>
      produce(state, (draft) => {
        draft.agentModalOpen = true
        draft.editingAgentId = null
      }),
    ),
  openEditAgentModal: (agentId) =>
    set((state) =>
      produce(state, (draft) => {
        draft.agentModalOpen = true
        draft.editingAgentId = agentId
      }),
    ),
  closeAgentModal: () =>
    set((state) =>
      produce(state, (draft) => {
        draft.agentModalOpen = false
        draft.editingAgentId = null
      }),
    ),
}))
