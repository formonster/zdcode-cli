import { Command } from 'commander'

const temp = (program: Command) => {
program
  .command('hello')
  .description('Hello World')
  .action(async () => {
    console.log('Hello World!')
  })
}

export default temp