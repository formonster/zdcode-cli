import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { getPackageRoot, getZdcodeModelsDir, getZdcodeTtsDir, getZdcodeVenvPython } from '../../utils/platform'
import { ensureVenv, pipInstall } from '../../utils/venv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const HF_MIRROR = process.env.ZDCODE_HF_MIRROR || 'https://hf-mirror.com'
const HF_API = 'https://huggingface.co'

export const DESIGN_VENV = 'qwen-tts'
export const CLONE_VENV = 'cosyvoice3'

export const DESIGN_MODEL_REPO = 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign'
export const CLONE_MODEL_REPO = 'FunAudioLLM/Fun-CosyVoice3-0.5B-2512'
export const CLONE_REPO_URL = 'https://github.com/drmhse/tts-funaudio-cozyvoice3.git'

/** VoiceDesign 必需文件（缺任一即视为未就绪） */
const DESIGN_FILES = [
  'config.json',
  'generation_config.json',
  'model.safetensors',
  'preprocessor_config.json',
  'tokenizer_config.json',
  'vocab.json',
  'merges.txt',
  'speech_tokenizer/config.json',
  'speech_tokenizer/configuration.json',
  'speech_tokenizer/preprocessor_config.json',
  'speech_tokenizer/model.safetensors',
]

/** CosyVoice3 实际推理需要的最小文件集（排除 fp32 onnx / rl 权重等冗余产物） */
const CLONE_FILES = [
  'campplus.onnx',
  'config.json',
  'configuration.json',
  'cosyvoice3.yaml',
  'CosyVoice-BlankEN/config.json',
  'CosyVoice-BlankEN/generation_config.json',
  'CosyVoice-BlankEN/merges.txt',
  'CosyVoice-BlankEN/model.safetensors',
  'CosyVoice-BlankEN/tokenizer_config.json',
  'CosyVoice-BlankEN/vocab.json',
  'flow.pt',
  'hift.pt',
  'llm.pt',
  'speech_tokenizer_v3.onnx',
]

export const getDesignModelDir = () => path.join(getZdcodeModelsDir(), 'Qwen3-TTS-12Hz-1.7B-VoiceDesign')

export const getCloneRepoDir = () => path.join(getZdcodeTtsDir(), 'cosyvoice3')

export const getCloneModelDir = () => path.join(getCloneRepoDir(), 'pretrained_models', 'Fun-CosyVoice3-0.5B')

export const getRuntimeScript = (name: string) => {
  const candidates = [
    path.resolve(__dirname, 'runtime', name),
    path.resolve(getPackageRoot(), 'src', 'modules', 'tts', 'runtime', name),
    path.resolve(process.cwd(), 'src', 'modules', 'tts', 'runtime', name),
  ]
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (!found) {
    throw new Error(`找不到 TTS 运行脚本 ${name}，已查找：${candidates.join(', ')}`)
  }
  return found
}

export const getRequirementsPath = (name: string) => {
  const candidates = [
    path.resolve(__dirname, 'requirements', name),
    path.resolve(getPackageRoot(), 'src', 'modules', 'tts', 'requirements', name),
    path.resolve(process.cwd(), 'src', 'modules', 'tts', 'requirements', name),
  ]
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (!found) {
    throw new Error(`找不到 TTS 依赖清单 ${name}，已查找：${candidates.join(', ')}`)
  }
  return found
}

type ManifestEntry = { name: string; size: number }

const fetchManifest = async (repoId: string): Promise<ManifestEntry[]> => {
  const response = await fetch(`${HF_API}/api/models/${repoId}?blobs=true`)
  if (!response.ok) {
    throw new Error(`获取模型清单失败（${repoId}）：HTTP ${response.status}`)
  }
  const data: any = await response.json()
  return (data?.siblings || []).map((item: any) => ({
    name: String(item.rfilename),
    size: Number(item.size) || 0,
  }))
}

const localSize = (filePath: string) => {
  try {
    return fs.statSync(filePath).size
  } catch {
    return -1
  }
}

const assertFilesReady = (dir: string, files: string[], sizes?: Map<string, number>) => {
  const missing: string[] = []
  for (const name of files) {
    const actual = localSize(path.join(dir, name))
    if (actual <= 0) {
      missing.push(name)
      continue
    }
    const expected = sizes?.get(name)
    if (expected && expected > 0 && actual !== expected) {
      missing.push(name)
    }
  }
  return missing
}

const downloadFile = (repoId: string, file: string, destDir: string) => {
  const dest = path.join(destDir, file)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const url = `${HF_MIRROR}/${repoId}/resolve/main/${file}`
  const result = spawnSync(
    'curl',
    ['-sSL', '--retry', '8', '--retry-delay', '3', '--retry-all-errors', '-C', '-', '-o', dest, url],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  )
  if (result.error) throw new Error(`下载 ${file} 失败：${result.error.message}`)
  if (result.status !== 0) throw new Error(`下载 ${file} 失败，curl 退出码 ${result.status}`)
}

const downloadModel = async (repoId: string, destDir: string, files: string[]) => {
  console.log(`⬇️  正在下载模型 ${repoId} → ${destDir}`)
  fs.mkdirSync(destDir, { recursive: true })
  const manifest = await fetchManifest(repoId)
  const sizes = new Map(manifest.map((entry) => [entry.name, entry.size]))

  const missing = assertFilesReady(destDir, files, sizes)
  if (missing.length === 0) return

  const ordered = [...missing].sort(
    (a, b) => (sizes.get(a) || 0) - (sizes.get(b) || 0)
  )
  for (const file of ordered) {
    const expected = sizes.get(file)
    console.log(`   - ${file}${expected ? ` (${(expected / 1024 / 1024).toFixed(1)} MB)` : ''}`)
    downloadFile(repoId, file, destDir)
  }

  const stillMissing = assertFilesReady(destDir, files, sizes)
  if (stillMissing.length > 0) {
    throw new Error(`模型下载不完整，缺失或大小不符：${stillMissing.join(', ')}`)
  }
  console.log(`✅ 模型就绪：${destDir}`)
}

export type DesignEngine = { python: string; modelDir: string }
export type CloneEngine = { python: string; repoDir: string; modelDir: string }

/** 确保 VoiceDesign 引擎就绪（环境 + 模型），缺失时自动安装 */
export const ensureDesignEngine = async (): Promise<DesignEngine> => {
  const custom = process.env.ZDCODE_TTS_DESIGN_PYTHON
  const managed = getZdcodeVenvPython(DESIGN_VENV)
  const python = custom || ensureVenv(DESIGN_VENV, getRequirementsPath('voicedesign.txt'), '3.12')
  if (custom && !fs.existsSync(custom)) {
    throw new Error(`ZDCODE_TTS_DESIGN_PYTHON 指向的解释器不存在：${custom}`)
  }

  const modelDir = getDesignModelDir()
  const missing = assertFilesReady(modelDir, DESIGN_FILES)
  if (missing.length > 0) {
    await downloadModel(DESIGN_MODEL_REPO, modelDir, DESIGN_FILES)
  }
  return { python, modelDir }
}

const ensureCloneRepo = () => {
  const repoDir = getCloneRepoDir()
  const marker = path.join(repoDir, 'cosyvoice', 'cli', 'cosyvoice.py')
  if (fs.existsSync(marker)) return repoDir

  if (fs.existsSync(repoDir)) {
    throw new Error(`目录已存在但缺少 cosyvoice 包，请手动检查：${repoDir}`)
  }

  console.log(`📦 正在克隆 CosyVoice3 仓库 → ${repoDir}`)
  fs.mkdirSync(path.dirname(repoDir), { recursive: true })
  const result = spawnSync('git', ['clone', '--depth', '1', CLONE_REPO_URL, repoDir], { stdio: 'inherit' })
  if (result.error) throw new Error(`克隆仓库失败：${result.error.message}`)
  if (result.status !== 0) throw new Error(`克隆仓库失败，git 退出码 ${result.status}`)

  if (!fs.existsSync(marker)) {
    throw new Error(`克隆完成但未找到 cosyvoice 包：${marker}`)
  }
  return repoDir
}

/** 确保 CosyVoice3 引擎就绪（仓库 + 环境 + 模型），缺失时自动安装 */
export const ensureCloneEngine = async (): Promise<CloneEngine> => {
  const repoDir = ensureCloneRepo()
  const custom = process.env.ZDCODE_TTS_CLONE_PYTHON
  const managed = getZdcodeVenvPython(CLONE_VENV)

  let python = custom || managed
  if (!custom && !fs.existsSync(managed)) {
    python = ensureVenv(CLONE_VENV, getRequirementsPath('cosyvoice3.txt'), '3.11')
    if (process.platform === 'darwin' && !fs.existsSync(path.join(path.dirname(managed), 'mlx_lm'))) {
      // mlx-lm 必须用 --no-deps 安装，否则会把 transformers 升到 5.x 破坏版本约束
      try {
        pipInstall(CLONE_VENV, ['--no-deps', 'mlx-lm==0.31.3'], '安装 mlx-lm')
      } catch (error: any) {
        console.log(`⚠️  mlx-lm 安装失败，服务将回退到 torch 后端：${error.message}`)
      }
    }
  }
  if (custom && !fs.existsSync(custom)) {
    throw new Error(`ZDCODE_TTS_CLONE_PYTHON 指向的解释器不存在：${custom}`)
  }

  const modelDir = getCloneModelDir()
  const missing = assertFilesReady(modelDir, CLONE_FILES)
  if (missing.length > 0) {
    await downloadModel(CLONE_MODEL_REPO, modelDir, CLONE_FILES)
  }
  return { python, repoDir, modelDir }
}

export type EngineStatus = {
  name: string
  ok: boolean
  python: string
  pythonExists: boolean
  modelDir: string
  missingFiles: string[]
}

export const inspectDesign = (): EngineStatus => {
  const python = process.env.ZDCODE_TTS_DESIGN_PYTHON || getZdcodeVenvPython(DESIGN_VENV)
  const modelDir = getDesignModelDir()
  const missingFiles = assertFilesReady(modelDir, DESIGN_FILES)
  return {
    name: 'design (VoiceDesign)',
    ok: fs.existsSync(python) && missingFiles.length === 0,
    python,
    pythonExists: fs.existsSync(python),
    modelDir,
    missingFiles,
  }
}

export const inspectClone = (): EngineStatus => {
  const python = process.env.ZDCODE_TTS_CLONE_PYTHON || getZdcodeVenvPython(CLONE_VENV)
  const modelDir = getCloneModelDir()
  const missingFiles = assertFilesReady(modelDir, CLONE_FILES)
  const repoReady = fs.existsSync(path.join(getCloneRepoDir(), 'cosyvoice', 'cli', 'cosyvoice.py'))
  return {
    name: 'clone (CosyVoice3)',
    ok: fs.existsSync(python) && repoReady && missingFiles.length === 0,
    python,
    pythonExists: fs.existsSync(python),
    modelDir,
    missingFiles,
  }
}
