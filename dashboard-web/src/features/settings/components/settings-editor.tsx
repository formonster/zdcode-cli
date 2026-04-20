import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { updateSettings } from '@/features/tasks/api/dashboard-api'
import type { AppSettings } from '@/shared/types/runtime'

type Props = {
  settings?: AppSettings
}

export function SettingsEditor({ settings }: Props) {
  const queryClient = useQueryClient()
  const [systemPrompt, setSystemPrompt] = useState('')

  useEffect(() => {
    setSystemPrompt(settings?.global_system_prompt ?? '')
  }, [settings?.global_system_prompt])

  const mutation = useMutation({
    mutationFn: async () => updateSettings({ global_system_prompt: systemPrompt }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
  })

  return (
    <div className="panel-surface codex-grid flex h-[calc(100vh-24px)] flex-col rounded-[28px] p-3">
      <div className="mb-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">Settings</p>
        <h2 className="mt-1 text-lg font-semibold">Global system prompt</h2>
        <p className="mt-1 text-sm text-muted-foreground">Apply a shared policy layer to every agent run.</p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col rounded-[24px] border border-white/8 bg-black/10 p-3">
        <Textarea
          rows={20}
          value={systemPrompt}
          onChange={(event) => setSystemPrompt(event.target.value)}
          className="min-h-0 flex-1 rounded-[20px] border-white/8 bg-background/40 text-[14px] leading-6"
          placeholder="Write the shared runtime policy here. This will be prepended to every agent's system prompt."
        />
        <div className="mt-3 flex justify-end">
          <Button variant="accent" onClick={() => void mutation.mutateAsync()} disabled={mutation.isPending}>
            Save Settings
          </Button>
        </div>
      </div>
    </div>
  )
}
