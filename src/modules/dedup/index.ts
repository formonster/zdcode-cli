import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { Command } from 'commander'
import { getZdcodeVenvPython } from '../../utils/platform'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/** Walk up from __dirname to find @zdcode/cli package.json → project root */
function findProjectRoot(): string {
  for (let dir = path.resolve(__dirname); ; dir = path.dirname(dir)) {
    const pkgPath = path.join(dir, 'package.json')
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
        if (pkg?.name === '@zdcode/cli') return dir
      } catch {}
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
  }
  // Fallback: assume source layout src/modules/dedup → 3 levels up
  return path.resolve(__dirname, '..', '..', '..')
}

const DEDUP_SCRIPT = path.join(findProjectRoot(), 'src', 'modules', 'dedup', 'dedup.py')

type DedupOptions = {
  python?: string
  threshold?: string
  vlm?: boolean
  vlmThreshold?: string
  dryRun?: boolean
  quiet?: boolean
}

const registerDedup = (program: Command) => {
  program
    .command('dedup')
    .description('关键帧去重 — 基于 dHash + 可选本地 minicpm-v 复核')
    .argument('<folder>', '图片文件夹路径（必填）')
    .option('--python <path>', 'Python 解释器路径', process.env.ZDCODE_DEDUP_PYTHON || getZdcodeVenvPython('dedup'))
    .option('--threshold <n>', 'dHash 汉明距离阈值，低于此值判定为冗余 (默认 5)', '5')
    .option('--vlm', '启用 VLM 复核（使用本地 Ollama minicpm-v 模型）')
    .option('--vlm-threshold <n>', 'VLM 复核灰区上限 (默认 3)', '3')
    .option('--dry-run', '仅预览，不实际删除文件')
    .option('--quiet', '静默模式，仅输出 JSON 结果')
    .action(async (folder: string, options: DedupOptions) => {
      const args = [
        DEDUP_SCRIPT,
        folder,
        '--threshold', options.threshold || '5',
      ]

      if (options.vlm) {
        args.push('--vlm')
      }
      if (options.vlmThreshold) {
        args.push('--vlm-threshold', options.vlmThreshold)
      }
      if (options.dryRun) {
        args.push('--dry-run')
      }
      if (options.quiet) {
        args.push('--quiet')
      }

      try {
        const cmd = [options.python || getZdcodeVenvPython('dedup'), ...args].map(a => `"${a}"`).join(' ')
        const result = execSync(cmd, {
          encoding: 'utf-8',
          stdio: ['inherit', 'pipe', 'inherit'],
          maxBuffer: 50 * 1024 * 1024,
        })
        process.stdout.write(result)
      } catch (p: any) {
        if (p.stdout) process.stdout.write(p.stdout)
        process.exit(p.status ?? 1)
      }
    })
}

export default registerDedup
