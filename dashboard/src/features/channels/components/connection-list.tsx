import { RadioTower } from 'lucide-react'

import type { ChannelConnection } from '@/shared/types/runtime'

type Props = {
  connections: ChannelConnection[]
}

export function ConnectionList({ connections }: Props) {
  return (
    <div className="space-y-1.5">
      {connections.map((connection) => {
        return (
          <div
            key={connection.id}
            className="flex w-full items-center gap-2 rounded-[16px] border border-white/8 bg-white/[0.02] px-3 py-2 text-left transition"
          >
            <div className="flex size-8 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04]">
              <RadioTower className="size-4 text-accent" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-foreground">{connection.name}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {connection.provider} · {connection.enabled ? 'enabled' : 'disabled'}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
