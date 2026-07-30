import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const ZDCODE_ENV_PATH = path.join(os.homedir(), '.zdcode', '.env')

export const readZdcodeEnv = () => {
  if (!fs.existsSync(ZDCODE_ENV_PATH)) {
    throw new Error(`API key file not found: ${ZDCODE_ENV_PATH}`)
  }

  return Object.fromEntries(
    fs.readFileSync(ZDCODE_ENV_PATH, 'utf-8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=')
        if (index < 0) return [line, '']
        const key = line.slice(0, index).trim()
        const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')
        return [key, value]
      })
  )
}
