import chalk from 'chalk'
import { Command } from 'commander'
import fs from 'node:fs'
import path from 'node:path'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

type ImageDiffOptions = {
  output?: string
  threshold?: string
  width?: string
  height?: string
}

const command = (program: Command) => {
  program
    .command('image-diff <imageA> <imageB>')
    .description('对比两张 PNG 图片并输出 diff 图片')
    .option('-o, --output <dir>', '输出图片目录，默认当前目录')
    .option('-t, --threshold <number>', '差异阈值，默认 0.1')
    .option('--width <number>', '对比前统一处理成指定宽度')
    .option('--height <number>', '对比前统一处理成指定高度')
    .action(async (imageA: string, imageB: string, options: ImageDiffOptions) => {
      await diffImages(imageA, imageB, options)
    })
}

export default command

async function diffImages(
  imageA: string,
  imageB: string,
  options: ImageDiffOptions
) {
  try {
    const firstImagePath = resolveReadableFile(imageA)
    const secondImagePath = resolveReadableFile(imageB)
    const outputDir = resolveOutputDir(options.output)
    const threshold = parseThreshold(options.threshold)

    const firstImage = readPng(firstImagePath)
    const secondImage = readPng(secondImagePath)
    const targetSize = resolveTargetSize(firstImage, secondImage, options)
    const normalizedFirstImage = normalizeImage(firstImage, targetSize)
    const normalizedSecondImage = normalizeImage(secondImage, targetSize)

    const { width, height } = targetSize
    const diffImage = new PNG({ width, height })
    const diffPixels = pixelmatch(
      normalizedFirstImage.data,
      normalizedSecondImage.data,
      diffImage.data,
      width,
      height,
      { threshold }
    )
    const outputPath = path.join(
      outputDir,
      `${getBaseName(firstImagePath)}-${getBaseName(secondImagePath)}-diff.png`
    )

    fs.writeFileSync(outputPath, PNG.sync.write(diffImage))

    console.log(chalk.green('✔'), '图片对比完成')
    console.log(
      '原始尺寸:',
      `${formatSize(firstImage)} vs ${formatSize(secondImage)}`
    )
    console.log('对比尺寸:', `${width}x${height}`)
    console.log('差异像素数:', diffPixels)
    console.log('输出路径:', outputPath)
  } catch (err: any) {
    console.log(chalk.red('× 图片对比失败:'), err?.message || err)
    process.exitCode = 1
  }
}

function resolveReadableFile(filePath: string) {
  const resolvedPath = path.resolve(process.cwd(), filePath)

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`文件不存在：${resolvedPath}`)
  }

  const stat = fs.statSync(resolvedPath)
  if (!stat.isFile()) {
    throw new Error(`不是有效文件：${resolvedPath}`)
  }

  return resolvedPath
}

function resolveOutputDir(output?: string) {
  const outputDir = path.resolve(process.cwd(), output || '.')
  fs.mkdirSync(outputDir, { recursive: true })
  return outputDir
}

function parseThreshold(threshold?: string) {
  if (threshold === undefined) {
    return 0.1
  }

  const value = Number(threshold)
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('threshold 必须是 0 到 1 之间的数字')
  }

  return value
}

function resolveTargetSize(
  firstImage: PNG,
  secondImage: PNG,
  options: ImageDiffOptions
) {
  if (options.width !== undefined || options.height !== undefined) {
    if (options.width === undefined || options.height === undefined) {
      throw new Error('width 和 height 必须同时指定')
    }

    return {
      width: parsePositiveInteger(options.width, 'width'),
      height: parsePositiveInteger(options.height, 'height'),
    }
  }

  return {
    width: Math.max(firstImage.width, secondImage.width),
    height: Math.max(firstImage.height, secondImage.height),
  }
}

function parsePositiveInteger(value: string, name: string) {
  const parsedValue = Number(value)
  if (
    !Number.isInteger(parsedValue) ||
    parsedValue <= 0 ||
    parsedValue > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(`${name} 必须是正整数`)
  }

  return parsedValue
}

function normalizeImage(
  image: PNG,
  targetSize: { width: number; height: number }
) {
  if (image.width === targetSize.width && image.height === targetSize.height) {
    return image
  }

  return containImage(image, targetSize)
}

function containImage(image: PNG, targetSize: { width: number; height: number }) {
  const normalizedImage = new PNG(targetSize)
  const scale = Math.min(
    targetSize.width / image.width,
    targetSize.height / image.height
  )
  const containedSize = {
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale)),
  }
  const offset = {
    x: Math.floor((targetSize.width - containedSize.width) / 2),
    y: Math.floor((targetSize.height - containedSize.height) / 2),
  }

  for (let targetY = 0; targetY < containedSize.height; targetY += 1) {
    const sourceY = Math.min(
      image.height - 1,
      Math.floor((targetY * image.height) / containedSize.height)
    )

    for (let targetX = 0; targetX < containedSize.width; targetX += 1) {
      const sourceX = Math.min(
        image.width - 1,
        Math.floor((targetX * image.width) / containedSize.width)
      )
      const sourceOffset = (sourceY * image.width + sourceX) * 4
      const targetOffset =
        ((targetY + offset.y) * targetSize.width + targetX + offset.x) * 4

      normalizedImage.data[targetOffset] = image.data[sourceOffset]
      normalizedImage.data[targetOffset + 1] = image.data[sourceOffset + 1]
      normalizedImage.data[targetOffset + 2] = image.data[sourceOffset + 2]
      normalizedImage.data[targetOffset + 3] = image.data[sourceOffset + 3]
    }
  }

  return normalizedImage
}

function readPng(filePath: string) {
  try {
    return PNG.sync.read(fs.readFileSync(filePath))
  } catch (err: any) {
    throw new Error(`PNG 图片读取失败：${filePath}，${err?.message || err}`)
  }
}

function getBaseName(filePath: string) {
  return path.basename(filePath, path.extname(filePath))
}

function formatSize(image: PNG) {
  return `${image.width}x${image.height}`
}
