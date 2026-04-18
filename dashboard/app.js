const state = {
  agents: [],
  models: [],
  tasks: [],
  approvals: [],
  memoryScopes: [],
  traces: [],
  selectedTaskId: null,
  selectedScopeId: null,
  editingAgentId: null,
  activePanel: 'overview',
  drafts: {
    agent: null,
    task: null,
    taskMessage: null,
  },
}

const q = (selector) => document.querySelector(selector)
const html = (selector, value) => {
  const node = q(selector)
  if (node) node.innerHTML = value
}

const api = async (path, options = {}) => {
  const response = await fetch(path, {
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  })
  const text = await response.text()
  const payload = text ? JSON.parse(text) : {}
  if (!response.ok) {
    throw new Error(payload.detail || payload.error || response.statusText)
  }
  return payload
}

const statusBadge = (status) =>
  `<span class="status ${status || ''}">${status || 'unknown'}</span>`

const escapeHtml = (value) =>
  String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')

const formatCode = (value) => `<pre class="code compact">${escapeHtml(value || '')}</pre>`

const formatPromptSnapshot = (event) => {
  const payload = event.payload || {}
  const summary = payload.context_summary || {}
  const sections = [
    ['System Prompt', payload.final_system_prompt || ''],
    ['User Input', payload.user_input || ''],
    ['Memory Context', payload.memory_context || '(disabled or empty)'],
  ]
  return `
    <details class="timeline-disclosure">
      <summary>View full prompt payload</summary>
      <div class="prompt-meta">
        <span>Estimated Tokens: ${summary.estimated_total_tokens || 0}</span>
        <span>System: ${summary.system_chars || 0} chars</span>
        <span>User: ${summary.user_chars || 0} chars</span>
        <span>Memory: ${summary.memory_chars || 0} chars</span>
      </div>
      ${sections
        .map(
          ([label, content]) => `
            <div class="prompt-section">
              <div class="eyebrow">${escapeHtml(label)}</div>
              ${formatCode(content)}
            </div>
          `,
        )
        .join('')}
    </details>
  `
}

const renderTimelineEvent = (event) => {
  const payload = event.payload || {}
  const eventType = event.event_type || 'event'
  const extra =
    eventType === 'prompt_snapshot'
      ? formatPromptSnapshot(event)
      : eventType === 'tool_call' || eventType === 'tool_result'
        ? `
          <div class="tool-meta">
            <span class="status">${escapeHtml(payload.tool || 'tool')}</span>
            ${payload.command ? `<span>${escapeHtml(payload.command)}</span>` : ''}
            ${payload.path ? `<span>${escapeHtml(payload.path)}</span>` : ''}
            ${payload.returncode !== undefined ? `<span>exit ${escapeHtml(payload.returncode)}</span>` : ''}
          </div>
          ${event.body ? formatCode(event.body) : ''}
        `
        : event.body
          ? `<p>${escapeHtml(event.body || '')}</p>`
          : ''

  return `
    <div class="timeline-item timeline-item-${escapeHtml(eventType)}">
      <div class="eyebrow">${escapeHtml(eventType)}</div>
      <strong>${escapeHtml(event.title)}</strong>
      ${extra}
    </div>
  `
}

const hasMeaningfulValue = (value) => {
  if (Array.isArray(value)) return value.length > 0
  return String(value || '').trim().length > 0
}

const setActivePanel = (panelName) => {
  state.activePanel = panelName || 'overview'
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.panel === state.activePanel)
  })
  document.querySelectorAll('.panel').forEach((panel) => {
    panel.classList.toggle('is-active', panel.id === `panel-${state.activePanel}`)
  })
  if (window.location.hash !== `#${state.activePanel}`) {
    window.location.hash = state.activePanel
  }
}

const captureDrafts = () => {
  const agentForm = q('#agent-form')
  if (agentForm) {
    const form = new FormData(agentForm)
    const draft = {
      agent_id: form.get('agent_id') || '',
      name: form.get('name') || '',
      description: form.get('description') || '',
      default_model: form.get('default_model') || '',
      workspace_binding: form.get('workspace_binding') || '',
      persona_prompt: form.get('persona_prompt') || '',
      skills_prompt: form.get('skills_prompt') || '',
    }
    state.drafts.agent =
      Object.values(draft).some((value) => hasMeaningfulValue(value)) || state.editingAgentId
        ? draft
        : null
  }

  const taskForm = q('#task-form')
  if (taskForm) {
    const form = new FormData(taskForm)
    const enabledAgentIds = Array.from(document.querySelectorAll('input[name="enabled_agents"]:checked')).map((input) => input.value)
    const draft = {
      title: form.get('title') || '',
      prompt: form.get('prompt') || '',
      max_turns: form.get('max_turns') || '30',
      entry_agent_id: form.get('entry_agent_id') || '',
      enabled_agent_ids: enabledAgentIds,
    }
    state.drafts.task =
      hasMeaningfulValue(draft.title) ||
      hasMeaningfulValue(draft.prompt) ||
      draft.max_turns !== '30' ||
      hasMeaningfulValue(draft.entry_agent_id) ||
      hasMeaningfulValue(draft.enabled_agent_ids)
        ? draft
        : null
  }

  const taskMessageForm = q('#task-message-form')
  if (taskMessageForm && !taskMessageForm.hidden) {
    const form = new FormData(taskMessageForm)
    const draft = {
      message_prompt: form.get('message_prompt') || '',
    }
    state.drafts.taskMessage = hasMeaningfulValue(draft.message_prompt) ? draft : null
  }
}

const restoreDrafts = () => {
  const agentDraft = state.drafts.agent
  if (agentDraft && q('#agent-form')) {
    q('#agent-form [name="agent_id"]').value = agentDraft.agent_id
    q('#agent-form [name="name"]').value = agentDraft.name
    q('#agent-form [name="description"]').value = agentDraft.description
    q('#agent-form [name="default_model"]').value =
      agentDraft.default_model || state.models.find((item) => item.is_default)?.model_key || 'volcengine/ark-code-latest'
    q('#agent-form [name="workspace_binding"]').value = agentDraft.workspace_binding
    q('#agent-form [name="persona_prompt"]').value = agentDraft.persona_prompt
    q('#agent-form [name="skills_prompt"]').value = agentDraft.skills_prompt
    if (agentDraft.agent_id) {
      state.editingAgentId = agentDraft.agent_id
      q('#agent-form-title').textContent = `Edit ${agentDraft.name || 'Agent'}`
      q('#agent-submit').textContent = 'Save Agent'
      q('#agent-cancel-edit').hidden = false
    }
  }

  const taskDraft = state.drafts.task
  if (taskDraft && q('#task-form')) {
    q('#task-form [name="title"]').value = taskDraft.title
    q('#task-form [name="prompt"]').value = taskDraft.prompt
    q('#task-form [name="max_turns"]').value = taskDraft.max_turns || '30'
    q('#task-form [name="entry_agent_id"]').value = taskDraft.entry_agent_id
    document.querySelectorAll('input[name="enabled_agents"]').forEach((input) => {
      input.checked = taskDraft.enabled_agent_ids.includes(input.value)
    })
  }

  const taskMessageDraft = state.drafts.taskMessage
  if (taskMessageDraft && q('#task-message-form') && !q('#task-message-form').hidden) {
    q('#task-message-form [name="message_prompt"]').value = taskMessageDraft.message_prompt
  }
}

const nav = () => {
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.addEventListener('click', () => {
      setActivePanel(button.dataset.panel)
    })
  })
}

const renderOverview = async () => {
  const health = await api('/health')
  q('#health-title').textContent = health.runtime?.agentsAvailable
    ? 'Runtime online'
    : 'Runtime online with degraded adapters'
  q('#health-copy').textContent = health.runtime?.openAIApiKey
    ? 'Agent execution is ready once tasks are created.'
    : 'OPENAI_API_KEY is missing, so task execution will fail until it is configured.'

  html(
    '#overview-stats',
    [
      ['Agents', state.agents.length],
      ['Tasks', state.tasks.length],
      ['Pending', state.approvals.filter((item) => item.status === 'pending').length],
      ['Memory Scopes', state.memoryScopes.length],
    ]
      .map(
        ([label, value]) => `
          <div class="stat">
            <div class="eyebrow">${label}</div>
            <strong>${value}</strong>
          </div>
        `,
      )
      .join(''),
  )

  html(
    '#overview-tasks',
    state.tasks.length
      ? state.tasks
          .slice(0, 4)
          .map(
            (task) => `
              <div class="item">
                <div class="item-header">
                  <strong>${escapeHtml(task.title)}</strong>
                  ${statusBadge(task.status)}
                </div>
                <p>${escapeHtml(task.prompt.slice(0, 140))}</p>
              </div>
            `,
          )
          .join('')
      : '<div class="empty">No tasks yet.</div>',
  )

  const pendingApprovals = state.approvals.filter((item) => item.status === 'pending')
  html(
    '#overview-approvals',
    pendingApprovals.length
      ? pendingApprovals
          .slice(0, 4)
          .map(
            (item) => `
              <div class="item">
                <div class="item-header">
                  <strong>${escapeHtml(item.title || item.tool_name)}</strong>
                  ${statusBadge(item.status)}
                </div>
                <p>${escapeHtml(item.body || item.tool_name)}</p>
              </div>
            `,
          )
          .join('')
      : '<div class="empty">No pending approvals.</div>',
  )

  q('#diagnostics-health').textContent = JSON.stringify(health, null, 2)
}

const renderAgents = () => {
  const currentModelValue = q('#agent-model-select')?.value
  html(
    '#agent-model-select',
    state.models.length
      ? state.models
          .map(
            (model) => `
              <option value="${model.model_key}" ${(currentModelValue ? model.model_key === currentModelValue : model.is_default) ? 'selected' : ''}>
                ${escapeHtml(model.alias || model.display_name)} (${escapeHtml(model.model_key)})
              </option>
            `,
          )
          .join('')
      : '<option value="volcengine/ark-code-latest">volcengine/ark-code-latest</option>',
  )

  html(
    '#agents-list',
    state.agents.length
      ? state.agents
          .map(
            (agent) => `
              <div class="item">
                <div class="item-header">
                  <strong>${escapeHtml(agent.name)}</strong>
                  ${statusBadge(agent.enabled ? 'enabled' : 'disabled')}
                </div>
                <p>${escapeHtml(agent.description || 'No description')}</p>
                <p><strong>Model:</strong> ${escapeHtml(agent.default_model)}</p>
                <p><strong>Workspace:</strong> ${escapeHtml(agent.workspace_binding)}</p>
                <div class="chips">
                  <button class="action agent-edit" data-agent-id="${agent.id}">Edit</button>
                </div>
              </div>
            `,
          )
          .join('')
      : '<div class="empty">Create your first Agent from the form on the left.</div>',
  )

  html(
    '#task-entry-agent',
    state.agents
      .map((agent) => `<option value="${agent.id}">${escapeHtml(agent.name)}</option>`)
      .join(''),
  )
  html(
    '#task-agent-options',
    state.agents
      .map(
        (agent) => `
          <label class="chip">
            <input type="checkbox" name="enabled_agents" value="${agent.id}" checked />
            <span>${escapeHtml(agent.name)}</span>
          </label>
        `,
      )
      .join(''),
  )

  document.querySelectorAll('.agent-edit').forEach((button) => {
    button.addEventListener('click', async () => {
      const agent = state.agents.find((item) => item.id === button.dataset.agentId)
      if (!agent) return
      state.editingAgentId = agent.id
      q('#agent-form-title').textContent = `Edit ${agent.name}`
      q('#agent-submit').textContent = 'Save Agent'
      q('#agent-cancel-edit').hidden = false
      q('#agent-form [name="agent_id"]').value = agent.id
      q('#agent-form [name="name"]').value = agent.name || ''
      q('#agent-form [name="description"]').value = agent.description || ''
      q('#agent-form [name="default_model"]').value = agent.default_model || 'volcengine/ark-code-latest'
      q('#agent-form [name="workspace_binding"]').value = agent.workspace_binding || '.'
      q('#agent-form [name="persona_prompt"]').value = agent.persona_prompt || ''
      q('#agent-form [name="skills_prompt"]').value = agent.skills_prompt || ''
    })
  })
}

const renderTasks = () => {
  html(
    '#tasks-list',
    state.tasks.length
      ? state.tasks
          .map(
            (task) => `
              <button class="item task-item" data-task-id="${task.id}">
                <div class="item-header">
                  <strong>${escapeHtml(task.title)}</strong>
                  ${statusBadge(task.status)}
                </div>
                <p>${escapeHtml(task.entry_agent_name || task.entry_agent_id)}</p>
              </button>
            `,
          )
          .join('')
      : '<div class="empty">No tasks yet.</div>',
  )

  document.querySelectorAll('.task-item').forEach((button) => {
    button.addEventListener('click', async () => {
      state.selectedTaskId = button.dataset.taskId
      setActivePanel('tasks')
      await renderTaskDetail()
    })
  })
}

const renderTaskDetail = async () => {
  if (!state.selectedTaskId) {
    html('#task-detail', '<div class="empty">Pick a task to inspect its timeline.</div>')
    q('#task-detail-title').textContent = 'Select a task'
    q('#task-message-form').hidden = true
    return
  }

  const task = await api(`/tasks/${state.selectedTaskId}`)
  q('#task-detail-title').textContent = task.title
  const pendingRun = (task.runs || []).find((run) => run.status === 'waiting_approval')
  q('#task-resume').dataset.runId = pendingRun?.id || ''
  q('#task-resume').disabled = !pendingRun
  q('#task-message-form').hidden = false
  q('#task-message-form button[type="submit"]').disabled = task.status === 'running' || task.status === 'waiting_approval'

  html(
    '#task-detail',
    `
      <div class="stack">
        <div class="item">
          <div class="item-header">
            <strong>Session</strong>
            ${statusBadge(task.status)}
          </div>
          <p><strong>Entry:</strong> ${escapeHtml(task.entry_agent_name || task.entry_agent_id)}</p>
          <p><strong>Enabled:</strong> ${escapeHtml((task.enabled_agent_ids || []).join(', '))}</p>
          <p><strong>Participants:</strong> ${escapeHtml((task.participating_agents || []).join(', '))}</p>
          <p><strong>Active:</strong> ${escapeHtml(task.active_agent_name || '-')}</p>
          <p><strong>Max Turns:</strong> ${escapeHtml(task.max_turns || 30)}</p>
          <p><strong>Context Size:</strong> ~${escapeHtml(task.context_summary?.estimated_total_tokens || 0)} tokens</p>
          <p><strong>System Prompt:</strong> ${escapeHtml(task.context_summary?.system_chars || 0)} chars</p>
          <p><strong>User Input:</strong> ${escapeHtml(task.context_summary?.user_chars || 0)} chars</p>
          <p><strong>Memory:</strong> ${escapeHtml(task.context_summary?.memory_chars || 0)} chars</p>
        </div>
        <div class="item">
          <div class="item-header">
            <strong>Prompt</strong>
          </div>
          <p>${escapeHtml(task.prompt)}</p>
        </div>
        <div class="item">
          <div class="item-header">
            <strong>Approvals</strong>
          </div>
          ${(task.approvals || []).length
            ? task.approvals
                .map(
                  (item) => `
                    <div class="item">
                      <div class="item-header">
                        <strong>${escapeHtml(item.title || item.tool_name)}</strong>
                        ${statusBadge(item.status)}
                      </div>
                      <p>${escapeHtml(item.body || '')}</p>
                    </div>
                  `,
                )
                .join('')
            : '<div class="empty">No approvals for this task.</div>'}
        </div>
      </div>
      <div class="stack">
        <div class="item">
          <div class="item-header">
            <strong>Timeline</strong>
          </div>
          <div class="timeline">
            ${(task.timeline || [])
              .map((event) => renderTimelineEvent(event))
              .join('') || '<div class="empty">No timeline events yet.</div>'}
          </div>
        </div>
      </div>
    `,
  )
}

const renderApprovals = () => {
  html(
    '#approvals-list',
    state.approvals.length
      ? state.approvals
          .map(
            (item) => `
              <div class="item">
                <div class="item-header">
                  <strong>${escapeHtml(item.title || item.tool_name)}</strong>
                  ${statusBadge(item.status)}
                </div>
                <p>${escapeHtml(item.body || '')}</p>
                <div class="chips">
                  <button class="action approval-action" data-id="${item.id}" data-action="approve">Approve</button>
                  <button class="action approval-action" data-id="${item.id}" data-action="reject">Reject</button>
                </div>
              </div>
            `,
          )
          .join('')
      : '<div class="empty">No approval items yet.</div>',
  )

  document.querySelectorAll('.approval-action').forEach((button) => {
    button.addEventListener('click', async () => {
      const approvalId = button.dataset.id
      const action = button.dataset.action
      if (action === 'approve') {
        await api(`/approvals/${approvalId}/approve`, { method: 'POST' })
      } else {
        await api(`/approvals/${approvalId}/reject`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'Rejected from dashboard' }),
        })
      }
      await refresh()
    })
  })
}

const renderMemory = () => {
  html(
    '#memory-list',
    state.memoryScopes.length
      ? state.memoryScopes
          .map(
            (scope) => `
              <button class="item memory-item" data-scope-id="${scope.scope_id}">
                <div class="item-header">
                  <strong>${escapeHtml(scope.scope_id)}</strong>
                  <span class="status">${escapeHtml(scope.provider)}</span>
                </div>
                <p>${escapeHtml(scope.summary || 'No summary yet.')}</p>
              </button>
            `,
          )
          .join('')
      : '<div class="empty">No memory scopes yet.</div>',
  )

  document.querySelectorAll('.memory-item').forEach((button) => {
    button.addEventListener('click', async () => {
      state.selectedScopeId = button.dataset.scopeId
      const scope = await api(`/memory/scopes/${state.selectedScopeId}`)
      q('#memory-detail-title').textContent = scope.scope_id
      html(
        '#memory-detail',
        `
          <div class="item">
            <div class="item-header">
              <strong>Summary</strong>
              <span class="status">${escapeHtml(scope.provider)}</span>
            </div>
            <p>${escapeHtml(scope.summary || 'No summary yet.')}</p>
            <div class="chips">
              <button class="action" id="memory-rebuild">Rebuild</button>
              <button class="action" id="memory-prune">Prune</button>
            </div>
          </div>
          ${(scope.episodes || [])
            .map(
              (episode) => `
                <div class="item">
                  <div class="item-header">
                    <strong>${escapeHtml(episode.created_at)}</strong>
                  </div>
                  <p>${escapeHtml(episode.episode)}</p>
                </div>
              `,
            )
            .join('')}
        `,
      )
      q('#memory-rebuild')?.addEventListener('click', async () => {
        await api(`/memory/scopes/${scope.scope_id}/rebuild`, { method: 'POST' })
        await refresh()
      })
      q('#memory-prune')?.addEventListener('click', async () => {
        await api(`/memory/scopes/${scope.scope_id}/prune`, { method: 'POST' })
        await refresh()
      })
    })
  })
}

const renderDiagnostics = () => {
  html(
    '#trace-list',
    state.traces.length
      ? state.traces
          .slice(0, 10)
          .map(
            (trace) => `
              <div class="item">
                <div class="item-header">
                  <strong>${escapeHtml(trace.agent_name)}</strong>
                  ${statusBadge(trace.status)}
                </div>
                <p>${escapeHtml(trace.final_output_preview || 'No output yet.')}</p>
              </div>
            `,
          )
          .join('')
      : '<div class="empty">No runs yet.</div>',
  )
}

const refresh = async () => {
  captureDrafts()
  const [agents, models, tasks, approvals, scopes, traces] = await Promise.all([
    api('/agents'),
    api('/models'),
    api('/tasks'),
    api('/approvals'),
    api('/memory/scopes'),
    api('/traces'),
  ])
  state.agents = agents
  state.models = models
  state.tasks = tasks
  state.approvals = approvals
  state.memoryScopes = scopes
  state.traces = traces

  renderAgents()
  renderTasks()
  renderApprovals()
  renderMemory()
  renderDiagnostics()
  restoreDrafts()
  await renderOverview()
  await renderTaskDetail()
}

const bindForms = () => {
  q('#agent-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const agentId = form.get('agent_id')
    const targetPath = agentId ? `/agents/${agentId}` : '/agents'
    await api(targetPath, {
      method: agentId ? 'PATCH' : 'POST',
      body: JSON.stringify({
        name: form.get('name'),
        description: form.get('description') || '',
        default_model: form.get('default_model') || 'volcengine/ark-code-latest',
        workspace_binding: form.get('workspace_binding') || '.',
        persona_prompt: form.get('persona_prompt') || '',
        skills_prompt: form.get('skills_prompt') || '',
        tool_profile: {
          shell: true,
          filesystem: true,
          browser: false,
        },
        memory_policy: {
          provider: 'mem0',
          scope: form.get('name'),
        },
        enabled: true,
      }),
    })
    event.currentTarget.reset()
    state.editingAgentId = null
    state.drafts.agent = null
    q('#agent-form-title').textContent = 'New Profile'
    q('#agent-submit').textContent = 'Create Agent'
    q('#agent-cancel-edit').hidden = true
    await refresh()
  })

  q('#task-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const enabled = Array.from(document.querySelectorAll('input[name="enabled_agents"]:checked')).map((input) => input.value)
    await api('/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: form.get('title') || String(form.get('prompt')).slice(0, 48),
        prompt: form.get('prompt'),
        max_turns: Number(form.get('max_turns') || 30),
        entry_agent_id: form.get('entry_agent_id'),
        enabled_agent_ids: Array.from(new Set([form.get('entry_agent_id'), ...enabled])),
      }),
    })
    event.currentTarget.reset()
    state.drafts.task = null
    await refresh()
  })

  q('#task-message-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!state.selectedTaskId) return
    const form = new FormData(event.currentTarget)
    await api(`/tasks/${state.selectedTaskId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        prompt: form.get('message_prompt'),
      }),
    })
    event.currentTarget.reset()
    state.drafts.taskMessage = null
    setActivePanel('tasks')
    await refresh()
  })

  q('#task-resume').addEventListener('click', async () => {
    const runId = q('#task-resume').dataset.runId
    if (!runId) return
    await api(`/runs/${runId}/resume`, { method: 'POST' })
    await refresh()
  })

  q('#agent-cancel-edit').addEventListener('click', () => {
    q('#agent-form').reset()
    q('#agent-form [name="agent_id"]').value = ''
    state.editingAgentId = null
    state.drafts.agent = null
    q('#agent-form-title').textContent = 'New Profile'
    q('#agent-submit').textContent = 'Create Agent'
    q('#agent-cancel-edit').hidden = true
    const defaultModel = state.models.find((item) => item.is_default)?.model_key || 'volcengine/ark-code-latest'
    q('#agent-form [name="default_model"]').value = defaultModel
  })
}

const init = async () => {
  const initialPanel = window.location.hash.replace(/^#/, '') || 'overview'
  state.activePanel = initialPanel
  nav()
  bindForms()
  await refresh()
  setActivePanel(state.activePanel)
  setInterval(refresh, 5000)
}

init().catch((error) => {
  q('#health-title').textContent = 'Runtime connection failed'
  q('#health-copy').textContent = error.message
})
