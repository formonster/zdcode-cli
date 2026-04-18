import * as React from 'react'

import { cn } from '@/shared/lib/utils'

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'flex h-12 w-full rounded-2xl border border-white/8 bg-white/4 px-4 py-3 text-sm text-foreground outline-none transition focus:border-white/18 focus:ring-2 focus:ring-ring',
      className,
    )}
    {...props}
  />
))
Input.displayName = 'Input'
