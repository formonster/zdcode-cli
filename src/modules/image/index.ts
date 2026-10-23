import fs from 'node:fs'
import path from 'node:path'
import { Command } from 'commander'
import { readZdcodeEnv, ZDCODE_ENV_PATH } from '../../utils/zdcode-env'

const DEFAULT_API_URL = 'https://api.kkrich.ltd/v1'
const DEFAULT_MODEL = 'gpt-image-2'
const RESPONSE_PREVIEW_LIMIT = 2000

type ImageOptions = {
  size?: string
  out?: string
  format?: 'b64_json' | 'url'
  image?: string[]
  apiUrl?: string
  model?: string
  n?: string
}

type ImageGenerationResponse = {
  data?: Array<{
    url?: string | null
    b64_json?: string | null
  }>
  error?: { message?: string } | string
  detail?: string
}

const collect = (value: string, previous: string[]) => [...previous, value]

const previewText = (text: string) => {
  const value = text.trim()
  if (!value) return '<empty>'
  return value.length > RESPONSE_PREVIEW_LIMIT
    ? `${value.slice(0, RESPONSE_PREVIEW_LIMIT)}...`
    : value
}

const parseJson = (text: string) => {
  if (!text.trim()) return {}
  try {
    return JSON.parse(text) as ImageGenerationResponse
  } catch {
    return undefined
  }
}

const apiErrorMessage = (response: Response, text: string, payload?: ImageGenerationResponse) => {
  const contentType = response.headers.get('content-type') || 'unknown'
  const message = typeof payload?.error === 'string'
    ? payload.error
    : payload?.error?.message || payload?.detail

  if (message) return message

  return [
    `Image API request failed: ${response.status} ${response.statusText}`,
    `content-type: ${contentType}`,
    `response body: ${previewText(text)}`,
  ].join('\n')
}

const errorDetails = (error: unknown) => {
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

const normalizeBaseUrl = (value: string) => {
  const url = value.trim().replace(/\/+$/, '')
  if (url.endsWith('/images/generations')) return url.slice(0, -'/images/generations'.length)
  if (url.endsWith('/images/edits')) return url.slice(0, -'/images/edits'.length)
  if (url.endsWith('/v1')) return url
  return `${url}/v1`
}

const imageConfig = (options: ImageOptions) => {
  const env = readZdcodeEnv()
  return {
    apiKey: env.IMAGE_API_KEY,
    baseUrl: normalizeBaseUrl(options.apiUrl || env.IMAGE_API_URL || DEFAULT_API_URL),
    model: options.model || env.IMAGE_MODEL || DEFAULT_MODEL,
    count: Math.max(1, Number(options.n || 1) || 1),
  }
}

const outputPath = (out?: string) => path.resolve(out || `image-${Date.now()}.png`)

const mimeType = (filePath: string) => {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return 'image/png'
}

const extensionForMime = (type: string) => {
  if (type.includes('jpeg') || type.includes('jpg')) return '.jpg'
  if (type.includes('webp')) return '.webp'
  if (type.includes('gif')) return '.gif'
  return '.png'
}

const loadImagePart = async (image: string) => {
  if (/^data:/i.test(image)) {
    const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(image)
    if (!match) throw new Error('Invalid data URI for input image')
    const type = match[1] || 'image/png'
    const buffer = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]))
    return { filename: `image${extensionForMime(type)}`, type, buffer }
  }
  if (/^https?:\/\//i.test(image)) {
    const response = await fetch(image)
    if (!response.ok) throw new Error(`Input image download failed: ${response.status} ${response.statusText}`)
    const type = (response.headers.get('content-type') || 'image/png').split(';')[0].trim()
    return {
      filename: `image${extensionForMime(type)}`,
      type,
      buffer: Buffer.from(await response.arrayBuffer()),
    }
  }
  const filePath = path.resolve(image)
  if (!fs.existsSync(filePath)) throw new Error(`Input image not found: ${filePath}`)
  if (!fs.statSync(filePath).isFile()) throw new Error(`Input image is not a file: ${filePath}`)
  return { filename: path.basename(filePath), type: mimeType(filePath), buffer: fs.readFileSync(filePath) }
}

const requestGenerations = async (prompt: string, config: ReturnType<typeof imageConfig>, options: ImageOptions) => {
  const body: Record<string, unknown> = { model: config.model, prompt, n: config.count }
  if (options.size) body.size = options.size
  if (options.format) body.response_format = options.format
  return fetch(`${config.baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

const requestEdits = async (prompt: string, images: string[], config: ReturnType<typeof imageConfig>, options: ImageOptions) => {
  const form = new FormData()
  form.append('model', config.model)
  form.append('prompt', prompt)
  form.append('n', String(config.count))
  if (options.size) form.append('size', options.size)
  if (options.format) form.append('response_format', options.format)
  for (const image of images) {
    const part = await loadImagePart(image)
    form.append('image', new Blob([part.buffer], { type: part.type }), part.filename)
  }
  return fetch(`${config.baseUrl}/images/edits`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}` },
    body: form,
  })
}

const writeBase64Image = (filePath: string, value: string) => {
  const base64 = value.includes(',') ? value.split(',').pop() || '' : value
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'))
}

const downloadImage = async (filePath: string, url: string) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Image download failed: ${response.status} ${response.statusText}`)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, Buffer.from(await response.arrayBuffer()))
}

export type GeneratedImage = { filePath?: string; url?: string }

export const generateImage = async (prompt: string, options: ImageOptions): Promise<GeneratedImage> => {
  const format = options.format || 'b64_json'
  const images = options.image || []
  const config = imageConfig(options)
  if (!config.apiKey) {
    throw new Error(`Missing IMAGE_API_KEY in ${ZDCODE_ENV_PATH}`)
  }

  let response: Response
  try {
    response = images.length
      ? await requestEdits(prompt, images, config, options)
      : await requestGenerations(prompt, config, options)
  } catch (error) {
    throw new Error(`Image API request failed before response: ${errorDetails(error)}`)
  }
  const text = await response.text()
  const payload = parseJson(text)
  if (!response.ok) {
    throw new Error(apiErrorMessage(response, text, payload))
  }
  if (!payload) throw new Error(apiErrorMessage(response, text))

  const image = payload.data?.[0]
  if (!image) throw new Error('No image returned.')

  if (format === 'url') {
    if (!image.url) throw new Error('No image URL returned.')
    if (options.out) {
      const filePath = outputPath(options.out)
      await downloadImage(filePath, image.url)
      console.log(`✅ Image written: ${filePath}`)
      return { filePath, url: image.url }
    }
    console.log(image.url)
    return { url: image.url }
  }

  const filePath = outputPath(options.out)
  if (!image.b64_json && image.url) {
    await downloadImage(filePath, image.url)
    console.log(`✅ Image written: ${filePath}`)
    return { filePath, url: image.url }
  }
  if (!image.b64_json) throw new Error('No base64 image returned.')
  writeBase64Image(filePath, image.b64_json)
  console.log(`✅ Image written: ${filePath}`)
  return { filePath }
}

const registerImageModule = (program: Command) => {
  program
    .command('image <prompt>')
    .description('生成图片；传 --image 时走图片编辑接口')
    .option('--size <size>', '输出尺寸，如 1024x1024（不传则用模型默认）')
    .option('-o, --out <path>', '输出图片路径')
    .option('--format <format>', 'b64_json | url，不传则按接口默认')
    .option('--n <count>', '生成数量', '1')
    .option('--api-url <url>', '图片接口 URL 或 OpenAI-compatible base URL')
    .option('--model <model>', '图片模型')
    .option('--image <image>', '图生图/编辑输入：本地路径、URL 或 Data URI，可重复', collect, [])
    .action(async (prompt: string, options: ImageOptions) => {
      try {
        if (options.format && options.format !== 'b64_json' && options.format !== 'url') {
          throw new Error('format must be b64_json or url')
        }
        await generateImage(prompt, options)
      } catch (error) {
        console.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })
}

export default registerImageModule
