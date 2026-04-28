import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, Cpu, KeyRound, Pencil, Plus, Save, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { createModel, setDefaultModel, updateModel, updateSettings } from '@/features/tasks/api/dashboard-api'
import { cn } from '@/shared/lib/utils'
import type { AppSettings, ModelRecord, ModelWritePayload } from '@/shared/types/runtime'

type Props = {
  settings?: AppSettings
  models: ModelRecord[]
}

type ModelFormState = ModelWritePayload

const emptyModelForm = (): ModelFormState => ({
  model_key: '',
  provider: '',
  model_id: '',
  display_name: '',
  alias: '',
  base_url: '',
  api_type: 'openai-completions',
  auth_mode: 'api_key',
  context_window: 0,
  max_tokens: 0,
  supports_text: true,
  supports_image: false,
  enabled: true,
  is_primary: false,
  api_key: '',
})

const modelLabel = (model: ModelRecord) => model.alias || model.display_name || model.model_key

const modelToForm = (model: ModelRecord): ModelFormState => ({
  model_key: model.model_key,
  provider: model.provider,
  model_id: model.model_id || model.model_key.split('/')[1] || '',
  display_name: model.display_name,
  alias: model.alias || '',
  base_url: model.base_url || '',
  api_type: model.api_type || 'openai-completions',
  auth_mode: model.auth_mode || 'api_key',
  context_window: model.context_window || 0,
  max_tokens: model.max_tokens || 0,
  supports_text: model.supports_text ?? true,
  supports_image: model.supports_image ?? false,
  enabled: model.enabled ?? true,
  is_primary: model.is_primary ?? false,
  api_key: '',
})

export function SettingsEditor({ settings, models }: Props) {
  const queryClient = useQueryClient()
  const [systemPrompt, setSystemPrompt] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [editingModelKey, setEditingModelKey] = useState<string | null>(null)
  const [modelForm, setModelForm] = useState<ModelFormState>(() => emptyModelForm())

  const currentDefaultModel = models.find((model) => model.is_default)?.model_key ?? models[0]?.model_key ?? ''
  const selectedModelRecord = models.find((model) => model.model_key === selectedModel)
  const editingModel = editingModelKey ? models.find((model) => model.model_key === editingModelKey) : null
  const isEditingModel = Boolean(editingModelKey)

  useEffect(() => {
    setSystemPrompt(settings?.global_system_prompt ?? '')
  }, [settings?.global_system_prompt])

  useEffect(() => {
    setSelectedModel(currentDefaultModel)
  }, [currentDefaultModel])

  const settingsMutation = useMutation({
    mutationFn: async () => updateSettings({ global_system_prompt: systemPrompt }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
  })

  const defaultModelMutation = useMutation({
    mutationFn: async () => setDefaultModel(selectedModel),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['models'] }),
        queryClient.invalidateQueries({ queryKey: ['settings'] }),
        queryClient.invalidateQueries({ queryKey: ['health'] }),
      ])
    },
  })

  const modelWriteMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        ...modelForm,
        model_key: modelForm.model_key.trim(),
        provider: modelForm.provider.trim(),
        model_id: modelForm.model_id.trim(),
        display_name: modelForm.display_name.trim(),
        alias: modelForm.alias.trim(),
        base_url: modelForm.base_url.trim(),
        api_type: modelForm.api_type.trim(),
        auth_mode: modelForm.auth_mode.trim(),
      }
      if (isEditingModel && editingModelKey) {
        const { model_key: _modelKey, ...patch } = payload
        return updateModel(editingModelKey, patch)
      }
      return createModel(payload)
    },
    onSuccess: async (model) => {
      setSelectedModel(model.model_key)
      setEditingModelKey(model.model_key)
      setModelForm(modelToForm(model))
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['models'] }),
        queryClient.invalidateQueries({ queryKey: ['health'] }),
      ])
    },
  })

  const startCreateModel = () => {
    setEditingModelKey(null)
    setModelForm(emptyModelForm())
  }

  const startEditModel = (model: ModelRecord) => {
    setEditingModelKey(model.model_key)
    setSelectedModel(model.model_key)
    setModelForm(modelToForm(model))
  }

  const updateForm = <K extends keyof ModelFormState>(key: K, value: ModelFormState[K]) => {
    setModelForm((current) => ({ ...current, [key]: value }))
  }

  const modelFormValid = Boolean(modelForm.model_key.trim() && modelForm.provider.trim() && modelForm.model_id.trim())

  return (
    <div className="panel-surface codex-grid flex h-[calc(100vh-24px)] flex-col overflow-hidden rounded-[28px] p-3">
      <div className="mb-3 shrink-0">
        <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">Settings</p>
        <h2 className="mt-1 text-lg font-semibold">Runtime controls</h2>
        <p className="mt-1 text-sm text-muted-foreground">Tune the shared prompt layer and model registry used by agents.</p>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto xl:grid-cols-[minmax(340px,0.8fr)_minmax(560px,1.2fr)] xl:overflow-hidden">
        <section className="flex min-h-0 flex-col rounded-[24px] border border-white/8 bg-black/10 p-3">
          <div className="mb-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">Prompt</p>
            <h3 className="mt-1 text-base font-semibold">Global system prompt</h3>
          </div>
          <Textarea
            rows={20}
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            className="min-h-0 flex-1 rounded-[20px] border-white/8 bg-background/40 text-[14px] leading-6"
            placeholder="Write the shared runtime policy here. This will be prepended to every agent's system prompt."
          />
          <div className="mt-3 flex justify-end">
            <Button variant="accent" onClick={() => void settingsMutation.mutateAsync()} disabled={settingsMutation.isPending}>
              <Save className="mr-2 size-4" />
              Save Prompt
            </Button>
          </div>
        </section>

        <section className="grid min-h-0 grid-cols-1 gap-3 2xl:grid-cols-[minmax(300px,0.9fr)_minmax(360px,1.1fr)]">
          <div className="flex min-h-0 flex-col rounded-[24px] border border-white/8 bg-black/10 p-3">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">Models</p>
                <h3 className="mt-1 text-base font-semibold">Default model</h3>
              </div>
              {selectedModelRecord ? <Badge>{selectedModelRecord.provider}</Badge> : null}
            </div>

            <div className="mb-3 rounded-[20px] border border-accent/15 bg-accent/8 p-3">
              <div className="flex items-start gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-[14px] border border-accent/20 bg-accent/15 text-accent">
                  <Cpu className="size-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{selectedModelRecord ? modelLabel(selectedModelRecord) : 'No model selected'}</p>
                  <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{selectedModel || 'Runtime has not returned a model registry yet.'}</p>
                </div>
              </div>
            </div>

            <div className="mb-3 flex gap-2">
              <Button variant="secondary" size="sm" className="rounded-[14px]" onClick={startCreateModel}>
                <Plus className="mr-2 size-4" />
                New Model
              </Button>
              {selectedModelRecord ? (
                <Button variant="ghost" size="sm" className="rounded-[14px]" onClick={() => startEditModel(selectedModelRecord)}>
                  <Pencil className="mr-2 size-4" />
                  Edit
                </Button>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {models.map((model) => {
                const active = selectedModel === model.model_key
                const editing = editingModelKey === model.model_key
                return (
                  <button
                    key={model.model_key}
                    type="button"
                    onClick={() => setSelectedModel(model.model_key)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-[18px] border p-3 text-left transition-colors',
                      active ? 'border-accent/35 bg-accent/12 text-foreground' : 'border-white/8 bg-white/[0.02] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground',
                      editing ? 'ring-1 ring-accent/40' : '',
                    )}
                  >
                    <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border', active ? 'border-accent bg-accent text-accent-foreground' : 'border-white/12')}>
                      {active ? <Check className="size-3.5" /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{modelLabel(model)}</span>
                      <span className="mt-1 block truncate font-mono text-[11px] opacity-70">{model.model_key}</span>
                    </span>
                    <span className="shrink-0 rounded-full border border-white/8 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] opacity-80">{model.provider}</span>
                  </button>
                )
              })}
              {!models.length ? <div className="rounded-[18px] border border-white/8 bg-white/[0.02] p-4 text-sm text-muted-foreground">No models returned from the runtime model registry.</div> : null}
            </div>

            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">{selectedModel === currentDefaultModel ? 'Current runtime default' : 'Unsaved model selection'}</p>
              <Button variant="accent" onClick={() => void defaultModelMutation.mutateAsync()} disabled={!selectedModel || selectedModel === currentDefaultModel || defaultModelMutation.isPending}>
                <Save className="mr-2 size-4" />
                Save Default
              </Button>
            </div>
          </div>

          <form
            className="flex min-h-0 flex-col rounded-[24px] border border-white/8 bg-black/10 p-3"
            onSubmit={(event) => {
              event.preventDefault()
              void modelWriteMutation.mutateAsync()
            }}
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">Registry</p>
                <h3 className="mt-1 text-base font-semibold">{isEditingModel ? 'Edit model' : 'New model'}</h3>
              </div>
              {isEditingModel ? (
                <Button type="button" variant="ghost" size="icon" className="rounded-[14px]" onClick={startCreateModel}>
                  <X className="size-4" />
                </Button>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
              <div className="grid gap-3 md:grid-cols-2">
                <Input value={modelForm.model_key} disabled={isEditingModel} onChange={(event) => updateForm('model_key', event.target.value)} placeholder="provider/model-id" />
                <Input value={modelForm.provider} onChange={(event) => updateForm('provider', event.target.value)} placeholder="provider" />
                <Input value={modelForm.model_id} onChange={(event) => updateForm('model_id', event.target.value)} placeholder="model id" />
                <Input value={modelForm.display_name} onChange={(event) => updateForm('display_name', event.target.value)} placeholder="display name" />
                <Input value={modelForm.alias} onChange={(event) => updateForm('alias', event.target.value)} placeholder="alias" />
                <Input value={modelForm.api_type} onChange={(event) => updateForm('api_type', event.target.value)} placeholder="api type" />
              </div>

              <Input value={modelForm.base_url} onChange={(event) => updateForm('base_url', event.target.value)} placeholder="base URL, e.g. https://api.example.com/v1" />

              <div className="grid gap-3 md:grid-cols-2">
                <Input value={modelForm.auth_mode} onChange={(event) => updateForm('auth_mode', event.target.value)} placeholder="auth mode" />
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    type="password"
                    value={modelForm.api_key}
                    onChange={(event) => updateForm('api_key', event.target.value)}
                    className="pl-10"
                    placeholder={editingModel?.api_key_present ? 'API key already saved' : 'API key'}
                  />
                </div>
                <Input type="number" min={0} value={modelForm.context_window} onChange={(event) => updateForm('context_window', Number(event.target.value))} placeholder="context window" />
                <Input type="number" min={0} value={modelForm.max_tokens} onChange={(event) => updateForm('max_tokens', Number(event.target.value))} placeholder="max tokens" />
              </div>

              <div className="grid gap-2 md:grid-cols-2">
                {[
                  ['supports_text', 'Text input'],
                  ['supports_image', 'Image input'],
                  ['enabled', 'Enabled'],
                  ['is_primary', 'Primary'],
                ].map(([key, label]) => (
                  <label key={key} className="flex items-center justify-between rounded-[16px] border border-white/8 bg-white/[0.02] px-3 py-2 text-sm">
                    <span>{label}</span>
                    <input
                      type="checkbox"
                      checked={Boolean(modelForm[key as keyof ModelFormState])}
                      onChange={(event) => updateForm(key as keyof ModelFormState, event.target.checked as never)}
                      className="size-4 accent-[hsl(var(--accent))]"
                    />
                  </label>
                ))}
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">{isEditingModel ? 'Saving keeps the existing model key.' : 'Model key must use provider/model format.'}</p>
              <Button type="submit" variant="accent" disabled={!modelFormValid || modelWriteMutation.isPending}>
                <Save className="mr-2 size-4" />
                {isEditingModel ? 'Save Changes' : 'Create Model'}
              </Button>
            </div>
          </form>
        </section>
      </div>
    </div>
  )
}
