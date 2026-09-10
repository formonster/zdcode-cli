import path from 'node:path'
import { Command } from 'commander'
import { agensImageConfig, imagesEndpoint, missingApiKeyError } from './api'
import {
  DEFAULT_API_URL,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_RATIO,
  DEFAULT_IMAGE_SIZE,
  IMAGE_RATIOS,
} from './constants'
import type { AgensImageOptions, ImageGenerationResponse } from './types'
import {
  collect,
  downloadFile,
  errorDetails,
  normalizeInputImage,
  outputPath,
  readJsonResponse,
  writeBase64File,
} from './utils'

const generateImage = async (prompt: string, options: AgensImageOptions) => {
  const config = agensImageConfig(options)
  if (!config.apiKey) throw new Error(missingApiKeyError('AGNES_IMAGE_API_KEY'))

  const format = options.format || 'url'
  if (format !== 'url' && format !== 'b64_json') {
    throw new Error('format must be url or b64_json')
  }
  const ratio = options.ratio || DEFAULT_IMAGE_RATIO
  if (!IMAGE_RATIOS.includes(ratio)) {
    throw new Error(`ratio must be one of: ${IMAGE_RATIOS.join(', ')}`)
  }

  const body: Record<string, unknown> = {
    model: config.model,
    prompt,
    size: options.size || DEFAULT_IMAGE_SIZE,
    ratio,
  }
  const images = (options.image || []).map(normalizeInputImage)
  if (images.length) body.image = images
  if (format === 'b64_json') {
    body.extra_body = { response_format: 'b64_json' }
  }

  let response: Response
  try {
    response = await fetch(imagesEndpoint(config.apiUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new Error(`Agens image request failed before response: ${errorDetails(error)}`)
  }

  const payload = await readJsonResponse<ImageGenerationResponse>('Agens image request failed', response)
  const item = payload.data?.[0]
  if (!item) throw new Error('Agens image request succeeded without an image result.')

  if (format === 'url') {
    if (!item.url) throw new Error('Agens image request returned no image URL.')
    if (options.out) {
      const filePath = path.resolve(options.out)
      await downloadFile(filePath, item.url)
      console.log(`✅ Image written: ${filePath}`)
    } else {
      console.log(item.url)
    }
    return
  }

  if (!item.b64_json) throw new Error('Agens image request returned no base64 image.')
  const filePath = outputPath(options.out)
  writeBase64File(filePath, item.b64_json)
  console.log(`✅ Image written: ${filePath}`)
}

export const registerAgensImage = (agens: Command) => {
  agens
    .command('image <prompt>')
    .description('使用 Agnes Image 2.5 Flash 生成图片（文生图 / 图生图 / 多图合成）')
    .option('--size <size>', '输出尺寸档位，推荐 1K/2K/3K/4K，也兼容 1024x768', DEFAULT_IMAGE_SIZE)
    .option('--ratio <ratio>', `宽高比，默认 1:1，可选：${IMAGE_RATIOS.join(' ')}`)
    .option('--format <format>', 'url | b64_json', 'url')
    .option('--image <image>', '输入图像 URL 或本地文件路径，可重复', collect, [])
    .option('-o, --out <path>', '输出图片路径')
    .option('--api-url <url>', 'Agnes API base URL', DEFAULT_API_URL)
    .option('--model <model>', '图像模型', DEFAULT_IMAGE_MODEL)
    .action(async (prompt: string, options: AgensImageOptions) => {
      try {
        await generateImage(prompt, options)
      } catch (error) {
        console.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
      }
    })
}
