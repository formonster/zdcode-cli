import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const apiKey = 'test-video-key'
const taskId = 'task_test_video'
const videoBytes = Buffer.from('mock-video')
let postCount = 0
let queryCount = 0

const readRequestBody = async (request) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf-8')
}

const server = http.createServer(async (request, response) => {
  assert.equal(request.headers.authorization, `Bearer ${apiKey}`)

  if (request.method === 'POST' && request.url === '/v1/video/generations') {
    postCount += 1
    assert.deepEqual(JSON.parse(await readRequestBody(request)), {
      model: 'sd_2.0_fast_special_720p',
      prompt: 'test prompt',
      seconds: '4',
      generate_audio: true,
    })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ id: taskId, status: 'queued' }))
    return
  }

  if (request.method === 'GET' && request.url === `/v1/video/generations/${taskId}`) {
    queryCount += 1
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      code: 'success',
      data: queryCount === 1
        ? { task_id: taskId, status: 'processing' }
        : { task_id: taskId, status: 'succeeded', url: `${baseUrl}/video.mp4` },
    }))
    return
  }

  if (request.method === 'GET' && request.url === '/video.mp4') {
    response.setHeader('content-type', 'video/mp4')
    response.end(videoBytes)
    return
  }

  response.statusCode = 404
  response.end('not found')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Mock server did not expose a port')
const baseUrl = `http://127.0.0.1:${address.port}`
const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'zdcode-video-test-'))
const outputPath = path.join(temporaryHome, 'result.mp4')

try {
  await fs.mkdir(path.join(temporaryHome, '.zdcode'))
  await fs.writeFile(path.join(temporaryHome, '.zdcode', '.env'), `VIDEO_API_KEY=${apiKey}\n`)

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      path.resolve('dist/index.js'),
      'video',
      'test prompt',
      '--api-url',
      baseUrl,
      '--poll-interval',
      '1',
      '--timeout',
      '5',
      '--out',
      outputPath,
    ],
    {
      cwd: path.resolve('.'),
      env: { ...process.env, HOME: temporaryHome },
      timeout: 10_000,
    },
  )

  assert.equal(stderr, '')
  assert.match(stdout, new RegExp(`task_id=${taskId}`))
  assert.match(stdout, /Video written:/)
  assert.equal(postCount, 1)
  assert.equal(queryCount, 2)
  assert.deepEqual(await fs.readFile(outputPath), videoBytes)
  console.log('video integration test passed')
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  await fs.rm(temporaryHome, { recursive: true, force: true })
}
