import { Command } from 'commander'
import { registerAgensImage } from './image'
import { registerAgensVideo } from './video'

const registerAgensModule = (program: Command) => {
  const agens = program.command('agens').description('Agnes AI 生图与生视频')
  registerAgensImage(agens)
  registerAgensVideo(agens)
}

export default registerAgensModule
