import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const PACKAGE_NAME = '@zdcode/cli'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let packageRoot: string | undefined

const findPackageRoot = () => {
  const startDirs = [
    process.cwd(),
    __dirname,
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '..', '..'),
  ]

  for (const startDir of startDirs) {
    let currentDir = path.resolve(startDir)

    for (;;) {
      const packageJsonPath = path.join(currentDir, 'package.json')

      if (fs.existsSync(packageJsonPath)) {
        try {
          const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
          if (packageJson?.name === PACKAGE_NAME) return currentDir
        } catch {
          // Keep walking upward; a malformed package.json elsewhere should not stop discovery.
        }
      }

      const parentDir = path.dirname(currentDir)
      if (parentDir === currentDir) break
      currentDir = parentDir
    }
  }

  return path.resolve(__dirname, '..', '..')
}

export const getPackageRoot = () => {
  packageRoot ||= findPackageRoot()
  return packageRoot
}
