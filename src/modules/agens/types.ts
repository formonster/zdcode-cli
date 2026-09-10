export type AgensImageOptions = {
  size?: string
  ratio?: string
  format?: string
  image?: string[]
  out?: string
  apiUrl?: string
  model?: string
}

export type AgensVideoOptions = {
  mode?: string
  seconds?: string
  size?: string
  aspectRatio?: string
  seed?: string
  firstFrame?: string
  lastFrame?: string
  image?: string[]
  audio?: string[]
  video?: string[]
  out?: string
  taskId?: string
  pollInterval?: string
  timeout?: string
  apiUrl?: string
  model?: string
}

export type ApiError = {
  code?: string
  message?: string
}

export type ImageItem = {
  url?: string | null
  b64_json?: string | null
}

export type ImageGenerationResponse = {
  data?: ImageItem[]
  error?: ApiError | string | null
  detail?: string
  message?: string
}

export type VideoTask = {
  id?: string
  task_id?: string
  video_id?: string
  status?: string
  progress?: number
  url?: string
  metadata?: {
    url?: string
  } | null
  error?: ApiError | string | null
}

export type VideoTaskResponse = VideoTask & {
  data?: VideoTask
  detail?: string
  message?: string
}
