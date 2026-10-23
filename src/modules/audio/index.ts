import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { getPackageRoot, getZdcodeVenvDir, getZdcodeVenvPython } from '../../utils/platform'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

type AudioModel = '1.0' | 'small'

type AudioOptions = {
  model?: string
  seconds?: string
  steps?: string
  cfg?: string
  seed?: string
  out?: string
  device?: string
  python?: string
}

const MODEL_ALIASES: Record<string, AudioModel> = {
  '1.0': '1.0',
  'sao-1.0': '1.0',
  'stable-audio-open-1.0': '1.0',
  small: 'small',
  'sao-small': 'small',
  'stable-audio-open-small': 'small',
}

const MODEL_DEFAULTS: Record<AudioModel, { seconds: number; steps: number; cfg: number }> = {
  '1.0': { seconds: 47, steps: 100, cfg: 7 },
  small: { seconds: 11.89, steps: 8, cfg: 1 },
}

const findRuntimeScript = () => {
  const candidates = [
    path.resolve(getPackageRoot(), 'src', 'modules', 'audio', 'runtime', 'generate.py'),
    path.resolve(__dirname, 'runtime', 'generate.py'),
    path.resolve(process.cwd(), 'src', 'modules', 'audio', 'runtime', 'generate.py'),
  ]
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (!found) {
    throw new Error(`找不到 Audio runtime 脚本，已检查：${candidates.join(', ')}`)
  }
  return found
}

const parseNumber = (value: string | undefined, fallback: number, name: string) => {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${name} 必须是数字`)
  return parsed
}

const resolveModel = (value?: string): AudioModel => {
  const model = MODEL_ALIASES[(value || '1.0').toLowerCase()]
  if (!model) throw new Error(`未知模型：${value}，可选 1.0 或 small`)
  return model
}

const resolvePython = (options: AudioOptions) => {
  const python = path.resolve(options.python || process.env.ZDCODE_AUDIO_PYTHON || getZdcodeVenvPython('audio'))
  if (!fs.existsSync(python)) {
    const venvDir = getZdcodeVenvDir('audio')
    throw new Error([
      `找不到 Audio Python 环境：${python}`,
      '请先初始化：',
      `  python3.11 -m venv ${venvDir}`,
      `  ${python} -m pip install -U stable-audio-tools torch safetensors einops`,
      '或用 --python 指定已有解释器。',
    ].join('\n'))
  }
  return python
}

export type AudioParams = {
  prompt: string
  out: string
  model?: string
  seconds?: string
  steps?: string
  cfg?: string
  seed?: string
  device?: string
  python?: string
}

export type AudioResult = {
  filePath: string
  model: AudioModel
  seconds: number
  steps: number
  cfg: number
  seed: number
  device: string
}

export const generateAudio = async (params: AudioParams): Promise<AudioResult> => {
  const model = resolveModel(params.model)
  const defaults = MODEL_DEFAULTS[model]
  const seconds = parseNumber(params.seconds, defaults.seconds, 'seconds')
  const steps = Math.round(parseNumber(params.steps, defaults.steps, 'steps'))
  const cfg = parseNumber(params.cfg, defaults.cfg, 'cfg')
  const seed = Math.round(parseNumber(params.seed, -1, 'seed'))
  if (seconds <= 0) throw new Error('seconds 必须大于 0')
  if (steps <= 0) throw new Error('steps 必须大于 0')
  if (cfg < 0) throw new Error('cfg 不能为负数')
  if (params.device !== undefined && params.device !== 'mps' && params.device !== 'cpu') {
    throw new Error('device 只能是 mps 或 cpu')
  }

  const python = resolvePython(params)
  const runtime = findRuntimeScript()
  const out = path.resolve(params.out)
  const device = params.device || 'mps'
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTORCH_ENABLE_MPS_FALLBACK: process.env.PYTORCH_ENABLE_MPS_FALLBACK || '1',
  }
  if (model === 'small' && !env.HF_ENDPOINT) {
    env.HF_ENDPOINT = 'https://hf-mirror.com'
  }

  console.log(`🎵 ${model} | ${seconds}s | ${steps} steps | cfg ${cfg} | seed ${seed}`)
  const result = spawnSync(
    python,
    [
      runtime,
      params.prompt,
      '--model', model,
      '--out', out,
      '--seconds', String(seconds),
      '--steps', String(steps),
      '--cfg', String(cfg),
      '--seed', String(seed),
      '--device', device,
    ],
    { stdio: 'inherit', env },
  )
  if (result.error) throw new Error(`执行失败：${result.error.message}`)
  if (result.status !== 0) throw new Error(`Audio 生成失败，Python 退出码 ${result.status}`)

  return { filePath: out, model, seconds, steps, cfg, seed, device }
}

const registerAudioModule = (program: Command) => {
  program
    .command('audio <prompt>')
    .description('生成音效、环境声或背景音乐（Stable Audio Open）')
    .option('--model <name>', '1.0（47 秒，质量更好）或 small（约 12 秒，速度快）', '1.0')
    .option('--seconds <seconds>', '生成时长（秒）')
    .option('--steps <steps>', '采样步数')
    .option('--cfg <scale>', '提示词引导强度')
    .option('--seed <seed>', '随机种子，-1 表示随机', '-1')
    .option('-o, --out <path>', '输出 wav 路径')
    .option('--device <device>', 'mps 或 cpu', 'mps')
    .option('--python <path>', '自定义 Python 解释器')
    .action(async (prompt: string, options: AudioOptions) => {
      try {
        const out = path.resolve(options.out || `audio-${Date.now()}.wav`)
        const result = await generateAudio({
          prompt,
          out,
          model: options.model,
          seconds: options.seconds,
          steps: options.steps,
          cfg: options.cfg,
          seed: options.seed,
          device: options.device,
          python: options.python,
        })
        console.log(`✅ Audio written: ${result.filePath}`)
      } catch (error) {
        console.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    })
}

export default registerAudioModule
