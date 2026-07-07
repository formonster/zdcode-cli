import path from 'path'
import { Command } from 'commander'
import { modelsBaseUrl } from '../models/store'
import {
  ArchiveSummaryOptions,
  loadFrames,
  loadMetadata,
  normalizeTranscript,
  optionalNumber,
  readJson,
  summarizeArchive,
  summarizeVideoTranscript,
  writeJson,
} from './core'
import { serveVideo } from './server'

type SummaryOptions = {
  transcript: string
  frames?: string
  metadata?: string
  title?: string
  url?: string
  out?: string
  serviceUrl?: string
  model?: string
  maxTokens?: string
}

type ServeOptions = {
  host?: string
  port?: string
  modelServiceUrl?: string
}

const summarizeTranscriptCommand = async (options: SummaryOptions) => {
  const transcript = normalizeTranscript(readJson<any>(options.transcript))
  const metadata = loadMetadata(options.metadata)
  const frames = loadFrames(options.frames)
  const summary = await summarizeVideoTranscript({
    transcript,
    frames,
    title: options.title || metadata.pageTitle || metadata.title || '',
    url: options.url || metadata.pageUrl || metadata.url || '',
    serviceUrl: options.serviceUrl,
    model: options.model,
    maxTokens: optionalNumber(options.maxTokens),
  })

  if (options.out) {
    writeJson(path.resolve(options.out), summary)
    console.log(`✅ Video summary written: ${path.resolve(options.out)}`)
  } else {
    console.log(JSON.stringify(summary, null, 2))
  }
}

const summarizeArchiveCommand = async (options: ArchiveSummaryOptions) => {
  const result = await summarizeArchive(options)
  console.log('✅ Archive summarized')
  console.log(`- archive: ${result.archive}`)
  console.log(`- summary: ${result.summaryPath}`)
}

const registerVideoModule = (program: Command) => {
  const video = program.command('video').description('视频学习总结编排工具')

  video
    .command('serve')
    .description('启动视频学习编排服务')
    .option('--host <host>', '监听地址', '127.0.0.1')
    .option('--port <port>', '监听端口', '4171')
    .option('--model-service-url <url>', '模型服务 URL', modelsBaseUrl())
    .action((options: ServeOptions) => {
      serveVideo({
        host: options.host,
        port: optionalNumber(options.port) || 4171,
        modelServiceUrl: options.modelServiceUrl,
      })
    })

  video
    .command('summarize')
    .description('根据转写时间轴生成章节和知识点总结')
    .requiredOption('--transcript <path>', '转写 JSON 文件')
    .option('--frames <path>', '关键帧 index.json')
    .option('--metadata <path>', '元数据 JSON 文件')
    .option('--title <title>', '页面标题')
    .option('--url <url>', '页面 URL')
    .option('--out <path>', '输出 summary.json')
    .option('--service-url <url>', '模型服务 URL', modelsBaseUrl())
    .option('--model <modelKey>', '模型 key；不传则使用模型服务默认模型')
    .option('--max-tokens <number>', '最大输出 token')
    .action(async (options: SummaryOptions) => {
      try {
        await summarizeTranscriptCommand(options)
      } catch (error) {
        console.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })

  video
    .command('summarize-archive')
    .description('读取插件归档目录，写回 summary/summary.json')
    .requiredOption('--archive <path>', '归档目录')
    .option('--service-url <url>', '模型服务 URL', modelsBaseUrl())
    .option('--model <modelKey>', '模型 key；不传则使用模型服务默认模型')
    .option('--max-tokens <number>', '最大输出 token')
    .option('--rename-folder', '按总结标题重命名归档目录', false)
    .action(async (options: ArchiveSummaryOptions) => {
      try {
        await summarizeArchiveCommand(options)
      } catch (error) {
        console.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })
}

export default registerVideoModule
