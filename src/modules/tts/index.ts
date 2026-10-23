import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { spawnSync } from 'child_process'
import { Command } from 'commander'
import { getZdcodeTtsDir } from '../../utils/platform'
import {
  ensureCloneEngine,
  ensureDesignEngine,
  getRuntimeScript,
  inspectClone,
  inspectDesign,
} from './engines'

type DesignOptions = {
  text?: string
  textFile?: string
  voice: string
  out: string
  language: string
  device?: string
  python?: string
}

type CloneOptions = {
  text?: string
  textFile?: string
  out: string
  instruct?: string
  speed: string
  nfe: string
  device: string
  refWav?: string
  refText?: string
  sentencePauseMs: string
  paragraphPauseMs: string
  python?: string
}

type ServeOptions = {
  host: string
  port: string
  device: string
  nfe: string
  llmBackend: string
  llmPrecision: string
  maxChars: string
  python?: string
}

const DEFAULT_OUT = 'tts-output.wav'

/** 支持 --text "..."、--text @file、--text-file file */
const resolveText = (text?: string, textFile?: string) => {
  if (textFile) {
    const resolved = path.resolve(textFile)
    if (!fs.existsSync(resolved)) throw new Error(`文本文件不存在：${resolved}`)
    return fs.readFileSync(resolved, 'utf-8').trim()
  }
  if (!text) throw new Error('缺少文本输入：请使用 --text 或 --text-file')
  if (text.startsWith('@')) {
    const resolved = path.resolve(text.slice(1))
    if (!fs.existsSync(resolved)) throw new Error(`文本文件不存在：${resolved}`)
    return fs.readFileSync(resolved, 'utf-8').trim()
  }
  return text
}

const runPython = (
  python: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
  exitOnError = true,
) => {
  const result = spawnSync(python, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
  if (result.error) throw new Error(`执行失败：${result.error.message}`)
  if (result.status !== 0) {
    if (!exitOnError) throw new Error(`Python 进程退出码 ${result.status}`)
    process.exit(result.status ?? 1)
  }
}

const withPythonOverride = async <T>(python: string | undefined, envKey: string, fn: () => Promise<T>) => {
  if (!python) return fn()
  const previous = process.env[envKey]
  process.env[envKey] = path.resolve(python)
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env[envKey]
    else process.env[envKey] = previous
  }
}

export type DesignParams = {
  text: string
  voice: string
  out: string
  language?: string
  device?: string
  python?: string
}

export type CloneParams = {
  text: string
  out: string
  instruct?: string
  speed?: string
  nfe?: string
  device?: string
  refWav?: string
  refText?: string
  sentencePauseMs?: string
  paragraphPauseMs?: string
  python?: string
}

/** 角色音设计：返回生成的 WAV 绝对路径 */
export const designAudio = async (params: DesignParams): Promise<string> => {
  const out = path.resolve(params.out)
  const engine = await withPythonOverride(params.python, 'ZDCODE_TTS_DESIGN_PYTHON', ensureDesignEngine)
  const script = getRuntimeScript('voicedesign_generate.py')

  console.log(`🎙️  角色音设计：${params.voice}`)
  runPython(engine.python, [
    script,
    '--text', params.text,
    '--voice', params.voice,
    '--out', out,
    '--language', params.language || 'Chinese',
    '--model', engine.modelDir,
    ...(params.device ? ['--device', params.device] : []),
  ], process.cwd(), {}, false)
  return out
}

/** 音色克隆：返回生成的 WAV 绝对路径 */
export const cloneAudio = async (params: CloneParams): Promise<string> => {
  const out = path.resolve(params.out)
  const engine = await withPythonOverride(params.python, 'ZDCODE_TTS_CLONE_PYTHON', ensureCloneEngine)
  const script = getRuntimeScript('cosyvoice3_speak.py')

  console.log('🔊 音色克隆合成中...')
  runPython(engine.python, [
    script,
    '--root', engine.repoDir,
    '--text', params.text,
    '--out', out,
    '--speed', params.speed || '1.0',
    '--nfe', params.nfe || '6',
    '--device', params.device || 'mps',
    '--sentence-pause-ms', params.sentencePauseMs || '0',
    '--paragraph-pause-ms', params.paragraphPauseMs || '0',
    ...(params.instruct ? ['--instruct', params.instruct] : []),
    ...(params.refWav ? ['--prompt-wav', path.resolve(params.refWav)] : []),
    ...(params.refText ? ['--prompt-text', params.refText] : []),
  ], engine.repoDir, {}, false)
  return out
}

const registerTtsModule = (program: Command) => {
  const tts = program.command('tts').description('本地语音合成（角色音设计 / 音色克隆）')

  tts
    .command('design')
    .description('角色音设计 — 用自然语言描述创造音色（Qwen3-TTS VoiceDesign）')
    .option('--text <text>', '要合成的文本，支持 @文件')
    .option('--text-file <path>', '从文件读取要合成的文本')
    .requiredOption('--voice <desc>', '音色描述，例如「撒娇稚嫩的萝莉女声，音调偏高」')
    .option('-o, --out <path>', '输出 WAV 路径', DEFAULT_OUT)
    .option('--language <lang>', '语言', 'Chinese')
    .option('--device <device>', 'mps | cpu，默认自动')
    .option('--python <path>', '自定义 Python 解释器（跳过自动安装）')
    .action(async (options: DesignOptions) => {
      const text = resolveText(options.text, options.textFile)
      const out = await designAudio({
        text,
        voice: options.voice,
        out: options.out,
        language: options.language,
        device: options.device,
        python: options.python,
      })
      console.log(`✅ 音频已生成：${out}`)
    })

  tts
    .command('clone')
    .description('音色克隆 — 零样本复刻参考音频音色，支持风格指令（CosyVoice3）')
    .option('--text <text>', '要合成的文本，支持 @文件')
    .option('--text-file <path>', '从文件读取要合成的文本')
    .option('-o, --out <path>', '输出 WAV 路径', DEFAULT_OUT)
    .option('--instruct <desc>', '风格/情绪指令，例如「请非常伤心地 slowly 说」')
    .option('--speed <n>', '语速 0.5-2.0', '1.0')
    .option('--nfe <n>', 'flow-matching 步数，越少越快', '6')
    .option('--device <device>', 'mps | cpu', 'mps')
    .option('--ref-wav <path>', '参考音频，默认使用内置 zero_shot_prompt.wav')
    .option('--ref-text <text>', '参考音频对应的逐字文本')
    .option('--sentence-pause-ms <n>', '句子间插入静音(ms)', '0')
    .option('--paragraph-pause-ms <n>', '段落间插入静音(ms)', '0')
    .option('--python <path>', '自定义 Python 解释器（跳过自动安装）')
    .action(async (options: CloneOptions) => {
      const text = resolveText(options.text, options.textFile)
      const out = await cloneAudio({
        text,
        out: options.out,
        instruct: options.instruct,
        speed: options.speed,
        nfe: options.nfe,
        device: options.device,
        refWav: options.refWav,
        refText: options.refText,
        sentencePauseMs: options.sentencePauseMs,
        paragraphPauseMs: options.paragraphPauseMs,
        python: options.python,
      })
      console.log(`✅ 音频已生成：${out}`)
    })

  tts
    .command('serve')
    .description('启动 CosyVoice3 HTTP 服务（/tts、/tts/stream、/v1/tts-jobs）')
    .option('--host <host>', '监听地址', '127.0.0.1')
    .option('--port <port>', '监听端口', '3003')
    .option('--device <device>', 'mps | cpu', 'mps')
    .option('--nfe <n>', 'flow-matching 步数', '6')
    .option('--llm-backend <backend>', 'mlx | torch', 'mlx')
    .option('--llm-precision <precision>', 'fp16 | fp32', 'fp16')
    .option('--max-chars <n>', '单次请求最大字符数', '1200')
    .option('--python <path>', '自定义 Python 解释器（跳过自动安装）')
    .action(async (options: ServeOptions) => {
      const engine = await withPythonOverride(options.python, 'ZDCODE_TTS_CLONE_PYTHON', ensureCloneEngine)

      const keyFile = path.join(getZdcodeTtsDir(), 'api_key')
      let apiKey = process.env.TTS_API_KEY
      if (!apiKey && fs.existsSync(keyFile)) apiKey = fs.readFileSync(keyFile, 'utf-8').trim()
      if (!apiKey) {
        apiKey = crypto.randomBytes(16).toString('hex')
        fs.mkdirSync(path.dirname(keyFile), { recursive: true })
        fs.writeFileSync(keyFile, apiKey, { mode: 0o600 })
      }

      const url = `http://${options.host}:${options.port}`
      console.log(`🚀 CosyVoice3 服务：${url}`)
      console.log(`   API Key：${apiKey}`)
      console.log(`   文档：${url}/llm.txt`)
      console.log(`   示例：curl -s -X POST ${url}/tts -H "Authorization: Bearer ${apiKey}" \\`)
      console.log('          -H "Content-Type: application/json" -d \'{"text":"你好"}\' --output out.wav')

      const result = spawnSync(engine.python, ['-m', 'uvicorn', 'serve:app', '--host', options.host, '--port', options.port], {
        cwd: engine.repoDir,
        stdio: 'inherit',
        env: {
          ...process.env,
          PYTHONPATH: `third_party/Matcha-TTS:${process.env.PYTHONPATH || ''}`,
          PYTORCH_ENABLE_MPS_FALLBACK: '1',
          TOKENIZERS_PARALLELISM: process.env.TOKENIZERS_PARALLELISM || 'false',
          TTS_API_KEY: apiKey,
          TTS_NFE: options.nfe,
          TTS_DEVICE: options.device,
          TTS_MAX_CHARS: options.maxChars,
          TTS_LLM_BACKEND: options.llmBackend,
          TTS_LLM_PRECISION: options.llmPrecision,
          TTS_JOB_ROOT: path.join(getZdcodeTtsDir(), 'var', 'tts-jobs'),
        },
      })
      process.exit(result.status ?? 0)
    })

  tts
    .command('doctor')
    .description('检查 TTS 引擎环境与模型是否就绪')
    .action(() => {
      const statuses = [inspectDesign(), inspectClone()]
      let allOk = true
      for (const status of statuses) {
        console.log(`\n${status.ok ? '✅' : '❌'} ${status.name}`)
        console.log(`   Python：${status.python} ${status.pythonExists ? '(已就绪)' : '(缺失)'}`)
        console.log(`   模型：${status.modelDir}`)
        console.log(`   缺失文件：${status.missingFiles.length === 0 ? '无' : status.missingFiles.join(', ')}`)
        if (!status.ok) allOk = false
      }
      console.log(allOk ? '\n全部引擎就绪。' : '\n运行对应命令会自动补齐缺失项。')
    })
}

export default registerTtsModule
