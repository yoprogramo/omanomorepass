'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const http = require('node:http')
const axios = require('axios')

const source = fs.readFileSync(require.resolve('../nmp-helper'), 'utf8')
function load(overrides = {}) {
  const context = {
    require: name => overrides[name] || require(name),
    module: { exports: {} }, process, setTimeout,
    ...overrides.globals
  }
  vm.runInNewContext(source, context)
  return context.module.exports
}

test('tokens retain the 12-character protocol format and use crypto', () => {
  let calls = 0
  const helper = load({ crypto: { randomInt: n => { assert.equal(n, 62); return calls++ % n } } })
  assert.equal(helper.newToken(), 'abcdefghijkl')
  assert.equal(calls, 12)
  const { newToken } = require('../nmp-helper')
  const tokens = new Set(Array.from({ length: 1000 }, newToken))
  assert.equal(tokens.size, 1000)
  for (const token of tokens) assert.match(token, /^[a-zA-Z0-9]{12}$/)
})

test('global deadline is installed before getid and cancels it', async () => {
  let deadline, cancelled = false, started = false
  const events = []
  const token = {}
  const helper = load({
    axios: {
      CancelToken: { source: () => ({ token, cancel: () => { cancelled = true } }) },
      post: (url, body, config) => {
        assert.ok(deadline)
        assert.equal(config.cancelToken, token)
        started = true
        return new Promise(() => {})
      }
    },
    globals: {
      setTimeout: (fn, ms) => { assert.equal(ms, 1000); deadline = fn },
      process: {
        argv: ['node', 'helper', '--timeout', '1'], env: {},
        stdout: { write: text => events.push(JSON.parse(text)) },
        stderr: { write() {} }, exit: code => { assert.equal(code, 0) }
      }
    }
  })
  helper.main()
  assert.ok(started)
  deadline()
  assert.ok(cancelled)
  assert.equal(events.at(-1).event, 'timeout')
})

test('vendored Axios enforces response, body, redirect and time limits', async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/large') res.end(Buffer.alloc(1024 * 1024 + 1))
    else if (req.url === '/redirect') { res.writeHead(302, { Location: '/redirect' }); res.end() }
    else if (req.url !== '/stall') res.end('{"resultado":"ok"}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const helper = load({ axios: {
    post: (url, body, config) => axios.post(
      `http://127.0.0.1:${server.address().port}${new URL(url).pathname.replace('/api', '')}`,
      body, { ...config, proxy: false })
  } })
  await assert.rejects(helper.post('/large', {}, ''), /maxContentLength/)
  await assert.rejects(helper.post('/redirect', {}, ''), /redirect/i)
  await assert.rejects(helper.post('/body', { site: 'x'.repeat(65537) }, ''), /maxBodyLength/)
  await assert.rejects(helper.post('/stall', {}, ''), /timeout of 10000ms/)
})

test('QML renders a PNG in memory without temporary files', () => {
  const { spawnSync } = require('node:child_process')
  const qml = fs.readFileSync(require.resolve('../NmpOverlay.qml'), 'utf8')
  const line = qml.split('\n').find(line => line.includes('qrencode -o -'))
  const command = vm.runInNewContext(line.trim().replace(/,$/, ''))
  const result = spawnSync('bash', ['-o', 'pipefail', '-c', command, 'nmp-qr', 'nomorepass://test'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^[A-Za-z0-9+/=]+\n$/)
  assert.equal(Buffer.from(result.stdout.trim(), 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.ok(!qml.includes('/tmp/omanomorepass-qr-'))
  const failed = spawnSync('bash', ['-o', 'pipefail', '-c', command, 'nmp-qr', 'x'.repeat(10000)], { encoding: 'utf8' })
  assert.notEqual(failed.status, 0)
})
