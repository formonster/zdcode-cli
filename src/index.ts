#!/usr/bin/env node
import { Command } from 'commander'
import 'zx/globals'
import packageJson from '../package.json'
import temp from './modules/hello'
import devModule from './modules/dev'
import feishuModule from './modules/feishu'

const program = new Command()

temp(program)
devModule(program)
feishuModule(program)

program.version(
  packageJson.version,
  '-v, --version',
  'output the current version'
)

program.parse(process.argv)
