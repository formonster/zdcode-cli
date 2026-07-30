import fs from 'node:fs'
import path from 'node:path'
import { Command } from 'commander'
import { readZdcodeEnv, ZDCODE_ENV_PATH } from '../../utils/zdcode-env'

const DEFAULT_API_URL = 'https://ea-n-qu153.xin-zhi-zhu.com'
const DEFAULT_MODEL = 'gpt-image-2'
const RESPONSE_PREVIEW_LIMIT = 2000

type ImageOptions = {
  size?: string
  out?: string
  format?: 'b64_json' | 'url'
  image?: string[]
  apiUrl?: string
  model?: string
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

const normalizeApiUrl = (value: string) => {
  const url = value.trim().replace(/\/+$/, '')
  if (url.endsWith('/images/generations')) return url
  if (url.endsWith('/v1')) return `${url}/images/generations`
  return `${url}/v1/images/generations`
}

const imageConfig = (options: ImageOptions) => {
  const env = readZdcodeEnv()
  return {
    apiKey: env.IMAGE_API_KEY,
    apiUrl: normalizeApiUrl(options.apiUrl || env.IMAGE_API_URL || DEFAULT_API_URL),
    model: options.model || env.IMAGE_MODEL || DEFAULT_MODEL,
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

const normalizeInputImage = (image: string) => {
  if (/^(https?:|data:)/i.test(image)) return image
  const filePath = path.resolve(image)
  if (!fs.existsSync(filePath)) return image
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error(`Input image is not a file: ${filePath}`)
  return `data:${mimeType(filePath)};base64,${fs.readFileSync(filePath).toString('base64')}`
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

const generateImage = async (prompt: string, options: ImageOptions) => {
  const format = options.format || 'b64_json'
  const images = (options.image || []).map(normalizeInputImage)
  const config = imageConfig(options)
  if (!config.apiKey) {
    throw new Error(`Missing IMAGE_API_KEY in ${ZDCODE_ENV_PATH}`)
  }

  const body: Record<string, unknown> = {
    model: config.model,
    prompt,
    size: options.size || '1024x768',
  }
  if (images.length) body.image = images
  if (format === 'url') body.response_format = 'url'

  let response: Response
  try {
    response = await fetch(config.apiUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
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
    } else {
      console.log(image.url)
    }
    return
  }

  const filePath = outputPath(options.out)
  if (!image.b64_json && image.url) {
    await downloadImage(filePath, image.url)
    console.log(`✅ Image written: ${filePath}`)
    return
  }
  if (!image.b64_json) throw new Error('No base64 image returned.')
  writeBase64Image(filePath, image.b64_json)
  console.log(`✅ Image written: ${filePath}`)
}

const registerImageModule = (program: Command) => {
  program
    .command('image <prompt>')
    .description('生成图片')
    .option('--size <size>', '输出尺寸', '1024x768')
    .option('-o, --out <path>', '输出图片路径')
    .option('--format <format>', 'b64_json | url', 'b64_json')
    .option('--api-url <url>', '图片接口 URL 或 OpenAI-compatible base URL')
    .option('--model <model>', '图片模型')
    .option('--image <image>', '图生图输入图像 URL 或 Data URI，可重复', collect, [])
    .action(async (prompt: string, options: ImageOptions) => {
      try {
        if (options.format !== 'b64_json' && options.format !== 'url') {
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
