import { defineConfig } from 'tsup'

export default defineConfig((options) => {
  return {
    entry: ['./src/index.ts', './src/test-feishu.ts'],
    minify: !options.watch,
    dts: true,
    format: ['esm', 'cjs']
  }
})
