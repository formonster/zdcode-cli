const API_BASE = import.meta.env.VITE_RUNTIME_BASE_URL?.replace(/\/$/, '') ?? 'http://127.0.0.1:4141'

export async function runtimeFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `Runtime request failed: ${response.status}`)
  }

  return (await response.json()) as T
}
