import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'

import { DashboardShell } from '@/features/dashboard/components/dashboard-shell'

export function App() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            refetchInterval: 5_000,
            retry: 1,
          },
        },
      }),
  )

  return (
    <QueryClientProvider client={queryClient}>
      <DashboardShell />
    </QueryClientProvider>
  )
}
