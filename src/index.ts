#!/usr/bin/env node
import { Command } from 'commander'
import 'zx/globals'
import packageJson from '../package.json'
import channelsModule from './modules/channels'
import temp from './modules/hello'
import devModule from './modules/dev'
import feishuModule from './modules/feishu'
import platformModule from './modules/platform'

const program = new Command()

temp(program)
devModule(program)
channelsModule(program)
feishuModule(program)
platformModule(program)

program.version(
  packageJson.version,
  '-v, --version',
  'output the current version'
)

program.parse(process.argv)
