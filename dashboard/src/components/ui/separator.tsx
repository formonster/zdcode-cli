import * as React from 'react'
import * as SeparatorPrimitive from '@radix-ui/react-separator'

import { cn } from '@/shared/lib/utils'

export function Separator({ className, orientation = 'horizontal', ...props }: React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      className={cn('shrink-0 bg-white/8', orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px', className)}
      decorative
      orientation={orientation}
      {...props}
    />
  )
}
