import fs from 'fs'
import path from 'path'
import { modelsBaseUrl } from '../models/store'

export type TranscriptSegment = {
  start?: string
  end?: string
  startSeconds?: number
  endSeconds?: number
  text: string
}

export type ArchiveSummaryOptions = {
  archive: string
  serviceUrl?: string
  model?: string
  maxTokens?: string | number
  renameFolder?: boolean
}

export const readJson = <T>(filePath: string): T => JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf-8')) as T

export const writeJson = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8')
}

export const optionalNumber = (value?: string | number) => {
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number: ${value}`)
  return parsed
}

const formatClock = (seconds: number) => {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(safeSeconds / 3600)
  const m = Math.floor((safeSeconds % 3600) / 60)
  const s = safeSeconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

const sanitizeFilename = (value: string) => {
  const cleaned = value.replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return (cleaned || 'untitled').slice(0, 120).replace(/[. ]+$/g, '')
}

const uniquePath = (target: string) => {
  if (!fs.existsSync(target)) return target
  const parsed = path.parse(target)
  for (let index = 2; index < 10000; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  throw new Error(`Unable to find unique path for ${target}`)
}

export const normalizeTranscript = (value: any): TranscriptSegment[] => {
  const rawSegments = Array.isArray(value) ? value : Array.isArray(value?.segments) ? value.segments : Array.isArray(value?.transcriptTimeline) ? value.transcriptTimeline : []
  return rawSegments
    .map((segment: any) => {
      const startSeconds = Number.isFinite(Number(segment.startSeconds)) ? Number(segment.startSeconds) : undefined
      const endSeconds = Number.isFinite(Number(segment.endSeconds)) ? Number(segment.endSeconds) : undefined
      return {
        start: segment.start || (startSeconds !== undefined ? formatClock(startSeconds) : ''),
        end: segment.end || (endSeconds !== undefined ? formatClock(endSeconds) : ''),
        startSeconds,
        endSeconds,
        text: String(segment.text || '').trim(),
      }
    })
    .filter((segment: TranscriptSegment) => segment.text)
}

const transcriptLine = (segment: TranscriptSegment) => {
  const start = segment.start || (segment.startSeconds !== undefined ? formatClock(segment.startSeconds) : '')
  const end = segment.end || (segment.endSeconds !== undefined ? formatClock(segment.endSeconds) : start)
  return `[${start || '-'}-${end || '-'}] ${segment.text}`
}

const frameLine = (frame: any) => {
  const time = frame.time || frame.start || frame.startSeconds || frame.recordingSeconds || ''
  const label = frame.file || frame.id || frame.path || ''
  return [time, label].filter(Boolean).join(': ')
}

const buildVideoSummaryPrompt = (params: {
  title: string
  url: string
  transcript: TranscriptSegment[]
  frames: any[]
}) => [
  '你是一个视频学习笔记助手。请把下面的转写时间轴作为一个整体理解，然后输出严格 JSON，不要 Markdown。',
  '输出必须使用简体中文。',
  '不要逐句总结，不要每条转写生成一个章节或一个知识点。',
  '你需要根据讲述内容的语义边界自行分段：判断内容可以分为几个章节，每个章节的主题是什么、覆盖的时间范围是什么、包含哪些关键知识点。',
  '每个章节和知识点都必须绑定到原始转写中的时间范围或证据时间点。不要编造没有转写依据的内容。',
  '知识点只保留标题、时间和原文证据，不要给每个知识点单独写 summary。',
  '',
  `页面标题：${params.title || '未命名视频'}`,
  `页面 URL：${params.url || ''}`,
  '',
  '关键帧索引：',
  params.frames.length ? params.frames.map(frameLine).filter(Boolean).join('\n') : '无',
  '',
  '完整转写：',
  params.transcript.map(transcriptLine).join('\n'),
].join('\n')

const videoSummarySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    overview: { type: 'string' },
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          summary: { type: 'string' },
          transcriptEvidence: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                start: { type: 'string' },
                end: { type: 'string' },
                text: { type: 'string' },
              },
              required: ['start', 'end', 'text'],
            },
          },
          knowledgePoints: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' },
                time: { type: 'string' },
                evidence: { type: 'string' },
              },
              required: ['title', 'time', 'evidence'],
            },
          },
        },
        required: ['title', 'start', 'end', 'summary', 'transcriptEvidence', 'knowledgePoints'],
      },
    },
  },
  required: ['title', 'overview', 'chapters'],
}

const callModelService = async (params: {
  serviceUrl?: string
  model?: string
  input: string
  maxTokens?: number
}) => {
  const baseUrl = (params.serviceUrl || modelsBaseUrl()).replace(/\/+$/, '')
  const body = {
    model_key: params.model,
    input: params.input,
    max_tokens: params.maxTokens,
    response_format: {
      type: 'json_schema',
      name: 'video_learning_summary',
      schema: videoSummarySchema,
    },
  }
  const postInvoke = async (payload: Record<string, unknown>) => fetch(`${baseUrl}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

  let response = await postInvoke(body)
  const text = await response.text()
  const payload = text ? JSON.parse(text) : {}
  if (!response.ok) {
    const message = payload?.error || payload?.detail || response.statusText
    if (/json_schema|response_format/i.test(message)) {
      const fallbackResponse = await postInvoke({
        ...body,
        response_format: undefined,
      })
      const fallbackText = await fallbackResponse.text()
      const fallbackPayload = fallbackText ? JSON.parse(fallbackText) : {}
      if (!fallbackResponse.ok) {
        throw new Error(fallbackPayload?.error || fallbackPayload?.detail || fallbackResponse.statusText)
      }
      return fallbackPayload as { text?: string; raw?: unknown }
    }
    throw new Error(message)
  }
  return payload as { text?: string; raw?: unknown }
}

const parseSummaryText = (text: string, transcript: TranscriptSegment[]) => {
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const parsed = JSON.parse(normalized)
  const chapters = Array.isArray(parsed.chapters) ? parsed.chapters.map((chapter: any) => {
    const [rangeStart, rangeEnd] = String(chapter.time_range || chapter.timeRange || '').split(/\s*[-~至到]\s*/, 2)
    const knowledgePoints = chapter.knowledgePoints || chapter.key_points || chapter.keyPoints || []
    return {
      title: chapter.title || '',
      start: chapter.start || rangeStart || '',
      end: chapter.end || rangeEnd || chapter.start || rangeStart || '',
      summary: chapter.summary || '',
      transcriptEvidence: Array.isArray(chapter.transcriptEvidence) ? chapter.transcriptEvidence : [],
      knowledgePoints: Array.isArray(knowledgePoints)
        ? knowledgePoints.map((point: any) => ({
            title: point.title || '',
            time: point.time || '',
            evidence: point.evidence || point.text || '',
          }))
        : [],
    }
  }) : []
  return {
    title: parsed.title || '学习总结',
    overview: parsed.overview || '',
    chapters,
    transcriptTimeline: transcript,
  }
}

export const summarizeVideoTranscript = async (params: {
  transcript: TranscriptSegment[]
  frames: any[]
  title: string
  url: string
  serviceUrl?: string
  model?: string
  maxTokens?: number
}) => {
  if (!params.transcript.length) {
    throw new Error('No transcript segments found.')
  }
  const modelPayload = await callModelService({
    serviceUrl: params.serviceUrl,
    model: params.model,
    maxTokens: params.maxTokens,
    input: buildVideoSummaryPrompt(params),
  })
  return parseSummaryText(modelPayload.text || '', params.transcript)
}

export const loadFrames = (filePath?: string) => {
  if (!filePath) return []
  if (!fs.existsSync(path.resolve(filePath))) return []
  const frames = readJson<any>(filePath)
  return Array.isArray(frames) ? frames : Array.isArray(frames?.frames) ? frames.frames : []
}

export const loadMetadata = (filePath?: string) => {
  if (!filePath || !fs.existsSync(path.resolve(filePath))) return {}
  return readJson<Record<string, any>>(filePath)
}

export const summarizeArchive = async (options: ArchiveSummaryOptions) => {
  const archivePath = path.resolve(options.archive)
  const metadataPath = path.join(archivePath, 'metadata.json')
  const transcriptPath = path.join(archivePath, 'transcript', 'final-transcript.json')
  const framesPath = path.join(archivePath, 'frames', 'index.json')
  const metadata = loadMetadata(metadataPath)
  const transcript = normalizeTranscript(readJson<any>(transcriptPath))
  const frames = loadFrames(framesPath)
  const summary = await summarizeVideoTranscript({
    transcript,
    frames,
    title: metadata.pageTitle || metadata.title || path.basename(archivePath),
    url: metadata.pageUrl || metadata.url || '',
    serviceUrl: options.serviceUrl,
    model: options.model,
    maxTokens: optionalNumber(options.maxTokens),
  })

  const summaryPath = path.join(archivePath, 'summary', 'summary.json')
  writeJson(summaryPath, summary)
  writeJson(metadataPath, {
    ...metadata,
    finalTitle: summary.title,
    summaryGeneratedAt: new Date().toISOString(),
  })

  let finalArchivePath = archivePath
  if (options.renameFolder && summary.title) {
    const target = uniquePath(path.join(path.dirname(archivePath), sanitizeFilename(summary.title)))
    if (target !== archivePath) {
      fs.renameSync(archivePath, target)
      finalArchivePath = target
    }
  }

  return {
    archive: finalArchivePath,
    summaryPath: path.join(finalArchivePath, 'summary', 'summary.json'),
    summary,
  }
}
