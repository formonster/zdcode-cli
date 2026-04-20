import { useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from '@tanstack/react-form'
import { RadioTower } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { createChannelConnection, updateChannelConnection } from '@/features/tasks/api/dashboard-api'
import type { ChannelConnection } from '@/shared/types/runtime'

function generateConnectionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `feishu-${crypto.randomUUID().slice(0, 8)}`
  }
  return `feishu-${Math.random().toString(36).slice(2, 10)}`
}

type Props = {
  connection?: ChannelConnection
  mode: 'create' | 'edit'
}

export function ConnectionEditor({ connection, mode }: Props) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (value: ChannelConnection) => {
      if (mode === 'edit' && connection) {
        return updateChannelConnection(connection.id, value)
      }
      return createChannelConnection(value)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['channel-connections'] })
    },
  })

  const form = useForm({
    defaultValues: {
      id: connection?.id ?? '',
      name: connection?.name ?? '',
      provider: connection?.provider ?? 'feishu',
      app_id: connection?.app_id ?? '',
      app_secret: connection?.app_secret ?? '',
      domain: connection?.domain ?? 'feishu',
      webhook: connection?.webhook ?? '',
      enabled: connection?.enabled ?? true,
    },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(value as ChannelConnection)
    },
  })

  useEffect(() => {
    form.reset({
      id: connection?.id ?? (mode === 'create' ? generateConnectionId() : ''),
      name: connection?.name ?? '',
      provider: connection?.provider ?? 'feishu',
      app_id: connection?.app_id ?? '',
      app_secret: connection?.app_secret ?? '',
      domain: connection?.domain ?? 'feishu',
      webhook: connection?.webhook ?? '',
      enabled: connection?.enabled ?? true,
    })
  }, [connection, form, mode])

  return (
    <Card className="rounded-[24px] bg-white/[0.03] p-4">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04]">
            <RadioTower className="size-5 text-accent" />
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.26em] text-muted-foreground">{mode === 'create' ? 'New connection' : 'Channel connection'}</p>
            <CardTitle className="mt-1 text-xl">{mode === 'create' ? 'Create connection' : connection?.name ?? 'Connection'}</CardTitle>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            event.stopPropagation()
            void form.handleSubmit()
          }}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <form.Field
              name="name"
              children={(field) => <Input value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} placeholder="Feishu Main" />}
            />
            <form.Field
              name="id"
              children={(field) => (
                <div className="flex h-11 items-center rounded-2xl border border-white/8 bg-white/[0.03] px-3 text-sm text-muted-foreground">
                  {field.state.value || 'auto generated'}
                </div>
              )}
            />
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <form.Field
              name="app_id"
              children={(field) => <Input value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} placeholder="cli_xxx" />}
            />
            <form.Field
              name="app_secret"
              children={(field) => <Input value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} placeholder="app secret" />}
            />
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <form.Field
              name="domain"
              children={(field) => <Input value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} placeholder="feishu" />}
            />
            <form.Field
              name="webhook"
              children={(field) => <Input value={field.state.value} onChange={(event) => field.handleChange(event.target.value)} placeholder="optional webhook" />}
            />
          </div>

          <div className="flex justify-end">
            <Button type="submit" variant="accent" className="h-10 px-4">
              {mode === 'create' ? 'Create Connection' : 'Save Connection'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
