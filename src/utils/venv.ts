import fs from 'fs'
import { spawnSync } from 'child_process'
import { getZdcodeVenvDir, getZdcodeVenvPython } from './platform'

const PYTHON_VERSION = '3.11'

const hasCommand = (command: string) => {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' })
  return !result.error && result.status === 0
}

const run = (command: string, args: string[], label: string) => {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw new Error(`${label}失败：${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label}失败，退出码 ${result.status}`)
}

const createVenv = (venvDir: string, pythonVersion: string) => {
  const exists = fs.existsSync(venvDir)
  if (hasCommand('uv')) {
    run('uv', ['venv', venvDir, '--python', pythonVersion, ...(exists ? ['--clear'] : [])], '创建虚拟环境')
    return
  }
  if (hasCommand('python3')) {
    if (exists) fs.rmSync(venvDir, { recursive: true, force: true })
    run('python3', ['-m', 'venv', venvDir], '创建虚拟环境')
    return
  }
  throw new Error('未找到 uv 或 python3，无法初始化 Python 环境。请先安装 uv：https://docs.astral.sh/uv/')
}

/** 向已存在的托管环境安装依赖 */
export const pipInstall = (name: string, args: string[], label = '安装依赖') => {
  const python = getZdcodeVenvPython(name)
  if (hasCommand('uv')) {
    run('uv', ['pip', 'install', '--python', python, ...args], label)
    return
  }
  run(python, ['-m', 'pip', 'install', ...args], label)
}

/**
 * 确保指定名称的 Python 虚拟环境已就绪。
 * 当解释器不存在时，自动创建环境并安装 requirements 中的依赖。
 * 返回该环境的 Python 解释器路径。
 */
export const ensureVenv = (name: string, requirementsPath: string, pythonVersion = PYTHON_VERSION) => {
  const python = getZdcodeVenvPython(name)
  if (fs.existsSync(python)) return python

  if (!fs.existsSync(requirementsPath)) {
    throw new Error(`依赖清单不存在：${requirementsPath}`)
  }

  const venvDir = getZdcodeVenvDir(name)
  console.log(`🔧 检测到 ${name} 运行环境缺失，正在自动初始化：${venvDir}`)
  createVenv(venvDir, pythonVersion)
  pipInstall(name, ['-r', requirementsPath])
  console.log(`✅ ${name} 运行环境初始化完成`)
  return python
}
