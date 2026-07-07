#!/usr/bin/env node
import { Command } from 'commander'
import 'zx/globals'
import packageJson from '../package.json'
import asrModule from './modules/asr'
import temp from './modules/hello'
import modelModule from './modules/models'
import videoModule from './modules/video'
import imageDiff from './modules/image-diff'
import agentsModule from './modules/agents'
import dedupModule from './modules/dedup'

const program = new Command()

temp(program)
asrModule(program)
modelModule(program)
videoModule(program)
imageDiff(program)
agentsModule(program)
dedupModule(program)

program.version(
  packageJson.version,
  '-v, --version',
  'output the current version'
)

program.parse(process.argv)
