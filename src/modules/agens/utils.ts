import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { RESPONSE_PREVIEW_LIMIT } from './constants'
import type { ApiError } from './types'

export const collect = (value: string, previous: string[]) => [...previous, value]

export const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export const previewText = (text: string) => {
  const value = text.trim()
  if (!value) return '<empty>'
  return value.length > RESPONSE_PREVIEW_LIMIT
    ? `${value.slice(0, RESPONSE_PREVIEW_LIMIT)}...`
    : value
}

export const parseJson = <T>(text: string): T | undefined => {
  if (!text.trim()) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

export const errorDetails = (error: unknown) => {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause
  if (!cause) return error.message
  const causeText = cause instanceof Error
    ? cause.message
    : typeof cause === 'object'
      ? JSON.stringify(cause)
      : String(cause)
  return `${error.message}: ${causeText}`
}

export const apiErrorMessage = (operation: string, response: Response, text: string, payload?: unknown) => {
  const value = payload as { error?: ApiError | string | null; detail?: string; message?: string } | undefined
  const error = value?.error
  const message = typeof error === 'string'
    ? error
    : error?.message || value?.detail || value?.message

  if (message) return `${operation}: ${message}`

  return [
    `${operation}: ${response.status} ${response.statusText}`,
    `content-type: ${response.headers.get('content-type') || 'unknown'}`,
    `response body: ${previewText(text)}`,
  ].join('\n')
}

export const positiveInteger = (value: string, name: string) => {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

export const outputPath = (out?: string) => path.resolve(out || `agens-${Date.now()}.png`)

export const mimeType = (filePath: string) => {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return 'image/png'
}

export const normalizeInputImage = (image: string) => {
  if (/^(https?:|data:)/i.test(image)) return image
  const filePath = path.resolve(image)
  if (!fs.existsSync(filePath)) return image
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error(`Input image is not a file: ${filePath}`)
  return `data:${mimeType(filePath)};base64,${fs.readFileSync(filePath).toString('base64')}`
}

export const writeBase64File = (filePath: string, value: string) => {
  const base64 = value.includes(',') ? value.split(',').pop() || '' : value
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'))
}

export const downloadFile = async (filePath: string, url: string) => {
  const response = await fetch(url)
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Download failed: ${response.status} ${response.statusText}\n${previewText(text)}`)
  }
  if (!response.body) throw new Error(`Download failed: response body is empty: ${url}`)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.part-${process.pid}`
  try {
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      fs.createWriteStream(temporaryPath),
    )
    fs.renameSync(temporaryPath, filePath)
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true })
    throw error
  }
}

export const readJsonResponse = async <T>(operation: string, response: Response) => {
  const text = await response.text()
  const payload = parseJson<T>(text)
  if (!response.ok) throw new Error(apiErrorMessage(operation, response, text, payload))
  if (!payload) throw new Error(apiErrorMessage(operation, response, text))
  return payload
}
