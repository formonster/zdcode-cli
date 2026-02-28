#!/usr/bin/env node
import { Command } from 'commander'
import 'zx/globals'
import packageJson from '../package.json'
import temp from './modules/hello'

const program = new Command()

temp(program)

program.version(
  packageJson.version,
  '-v, --version',
  'output the current version'
)

program.parse(process.argv)