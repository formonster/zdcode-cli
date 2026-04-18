import * as React from 'react'

import { cn } from '@/shared/lib/utils'

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'flex min-h-28 w-full rounded-[24px] border border-white/8 bg-white/4 px-4 py-3 text-sm text-foreground outline-none transition focus:border-white/18 focus:ring-2 focus:ring-ring',
      className,
    )}
    {...props}
  />
))
Textarea.displayName = 'Textarea'
