import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@/shared/lib/utils'

const badgeVariants = cva('inline-flex items-center rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.22em]', {
  variants: {
    variant: {
      default: 'border-white/10 bg-white/5 text-foreground',
      success: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200',
      warning: 'border-amber-400/20 bg-amber-400/10 text-amber-200',
      danger: 'border-rose-400/20 bg-rose-400/10 text-rose-200',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
})

export function Badge({ className, variant, ...props }: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof badgeVariants>) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}
