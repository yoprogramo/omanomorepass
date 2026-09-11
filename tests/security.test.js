'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const http = require('node:http')
const axios = require('axios')
const { createRequire } = require('node:module')
const helperRequire = createRequire(require.resolve('../nmp-helper'))
const { limits, boundedString, validEvent, lineStream } = require('../protocol')

const source = fs.readFileSync(require.resolve('../nmp-helper'), 'utf8')
function load(overrides = {}) {
  const context = {
    require: name => overrides[name] || helperRequire(name),
    module: { exports: {} }, process, setTimeout, Buffer,
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
    if (req.url === '/large') res.end(Buffer.alloc(limits.response + 1))
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

test('QR rendering uses a fixed executable and bounded stdin, never argv or environment', () => {
  const secret = 'nomorepass://secret-ticket'
  let called = false
  const helper = load({ 'node:child_process': { spawnSync: (file, args, opts) => {
    called = true
    assert.equal(file, '/usr/bin/qrencode')
    assert.equal(args.includes(secret), false)
    assert.equal(opts.input.toString(), secret)
    assert.deepEqual({ ...opts.env }, { LANG: 'C.UTF-8' })
    assert.equal(opts.timeout, 3000)
    assert.equal(opts.maxBuffer, limits.png)
    return { status: 0, stdout: Buffer.from('89504e470d0a1a0a', 'hex') }
  } } })
  helper.renderQr(secret)
  assert.ok(called)
  called = false
  for (const text of [null, {}, 'x', 'nomorepass://\0', 'nomorepass://' + 'x'.repeat(limits.qr)])
    assert.throws(() => helper.renderQr(text), /Invalid QR/)
  assert.equal(called, false)
})

test('real qrencode renders a bounded PNG even with poisoned PATH', () => {
  const { renderQr } = require('../nmp-helper')
  const oldPath = process.env.PATH
  try {
    process.env.PATH = '/nonexistent/shadow-bin'
    const png = Buffer.from(renderQr('nomorepass://' + 'x'.repeat(400)), 'base64')
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.ok(png.length < limits.png)
  } finally { process.env.PATH = oldPath }
})

test('QR errors and output overflow fail closed without disclosing child diagnostics', () => {
  for (const result of [
    { status: 1, stderr: Buffer.from('secret') },
    { status: 0, error: new Error('secret') },
    { status: 0, stdout: Buffer.alloc(limits.png + 1) },
    { status: 0, stdout: Buffer.from('not a PNG') }
  ]) {
    const helper = load({ 'node:child_process': { spawnSync: () => result } })
    assert.throws(() => helper.renderQr('nomorepass://test'), e => !e.message.includes('secret'))
  }
})

test('API schemas reject type, size, cardinality and encrypted envelope violations', () => {
  const { validateTicket, validatePoll } = require('../nmp-helper')
  const encrypted = require('crypto-js').AES.encrypt('secret', 'abcdefghijkl').toString()
  const grant = { resultado: 'ok', grant: 'grant', usuario: 'user', password: encrypted, extra: '{}' }
  assert.equal(validateTicket({ resultado: 'ok', ticket: 'ticket-123' }), 'ticket-123')
  assert.equal(validatePoll(grant), grant)
  for (const state of ['waiting', 'deny', 'expired']) validatePoll({ resultado: 'ok', grant: state })
  for (const ticket of [null, [], {}, 123, '', 'x'.repeat(129), 'ticket\n', 'é'])
    assert.throws(() => validateTicket({ resultado: 'ok', ticket }))
  assert.throws(() => validateTicket({ resultado: 'ok', ticket: 'valid', extra: 1 }))
  for (const patch of [
    { usuario: {} }, { usuario: 'ü'.repeat(257) }, { usuario: null },
    { password: {} }, { password: 'x'.repeat(limits.encrypted + 1) }, { password: 'AAAA' },
    { password: Buffer.alloc(32).toString('base64') }, { password: encrypted + '\n' },
    { extra: [] }, { extra: 'x'.repeat(limits.extra + 1) }, { surprise: 'x' }, { grant: {} }, { grant: 'unknown' }
  ]) assert.throws(() => validatePoll({ ...grant, ...patch }))
  assert.throws(() => validatePoll([grant]))
  assert.throws(() => validatePoll({ resultado: 'ok', grant: 'grant' }))
})

test('malformed responses never reach QR generation or decryption', async () => {
  for (const invalidTicket of [true, false]) {
    const events = [], timers = []
    let decryptCalls = 0, qrCalls = 0
    const helper = load({
      axios: {
        CancelToken: { source: () => ({ token: {}, cancel() {} }) },
        post: async url => ({ data: url.endsWith('getid.php')
          ? { resultado: 'ok', ticket: invalidTicket ? {} : 'ticket' }
          : { resultado: 'ok', grant: 'grant', usuario: 'user', password: {} } })
      },
      'crypto-js': { AES: { decrypt: () => { decryptCalls++ } } },
      'node:child_process': { spawnSync: () => {
        qrCalls++
        return { status: 0, stdout: Buffer.from('89504e470d0a1a0a', 'hex') }
      } },
      globals: {
        setTimeout: (fn, ms) => timers.push({ fn, ms }),
        process: { argv: ['node', 'helper'], env: {}, exit() {},
          stdout: { write: line => events.push(JSON.parse(line)) }, stderr: { write() {} } }
      }
    })
    await helper.main()
    if (!invalidTicket) await timers.find(timer => timer.ms === 3000).fn()
    assert.equal(qrCalls, invalidTicket ? 0 : 1)
    assert.equal(decryptCalls, 0)
    assert.equal(events.at(-1).event, 'error')
  }
})

test('plaintext, UTF-8 and output limits are enforced', () => {
  const { parseArgs } = require('../nmp-helper')
  assert.ok(boundedString('😀'.repeat(1024), limits.password))
  assert.ok(!boundedString('😀'.repeat(1025), limits.password))
  assert.ok(!boundedString('\ud800', limits.password))
  assert.throws(() => parseArgs(['--site', 'é'.repeat(129)]))
  const events = []
  const helper = load({ globals: { process: { stdout: { write: line => events.push(line) } } } })
  helper.send({ event: 'credentials', user: '', password: '\0'.repeat(limits.password) })
  assert.ok(events[0].length < limits.line)
  helper.send({ event: 'credentials', user: '', password: '😀' })
  assert.match(events[1], /^[\x00-\x7f]+$/)
  assert.throws(() => helper.send({ event: 'credentials', user: '', password: 'x'.repeat(limits.password + 1) }))
  assert.ok(!validEvent({ event: 'qr', text: 'secret' }))
  assert.ok(!validEvent({ event: 'qr', image: 'iVBORw0KGgo' + 'A'.repeat(limits.image) }))
})

test('chunk parser bounds unterminated lines, total output, cardinality and partial EOF', () => {
  const output = []
  const stream = lineStream(4, 12, 3)
  assert.ok(stream.push('ab', line => output.push(line)))
  assert.ok(stream.push('cd\nx\n', line => output.push(line)))
  assert.deepEqual(output, ['abcd', 'x'])
  assert.ok(stream.finish())
  assert.ok(stream.push('1234', () => {}))
  assert.equal(stream.finish(), false)
  assert.equal(stream.push('5', () => {}), false)
  assert.equal(stream.buffer, '')
  assert.equal(stream.push('\n', () => {}), false)
  assert.equal(lineStream(4, 5, 10).push('a\na\na\n', () => {}), false)
  assert.equal(lineStream(4, 20, 2).push('a\nb\nc\n', () => {}), false)
  assert.equal(lineStream(4, 20, 2).push('ééé', () => {}), false)
})

test('terminal events drain completely before process exit', () => {
  let drained, exited = false
  const helper = load({ globals: { process: {
    stdout: { write: (line, done) => { assert.ok(line.length > 4096); drained = done } },
    exit: code => { assert.equal(code, 0); exited = true }
  } } })
  helper.finish({ event: 'credentials', user: '', password: '\0'.repeat(limits.password) })
  assert.equal(exited, false)
  drained()
  assert.equal(exited, true)
})

function qmlFunction(qml, name, context) {
  const start = qml.indexOf('  function ' + name + '(')
  const end = qml.indexOf('\n  }', start) + 4
  return vm.runInNewContext('(' + qml.slice(start, end).trim() + ')', context)
}

test('clipboard uses direct stdin and clears retained secrets', () => {
  const qml = fs.readFileSync(require.resolve('../NmpOverlay.qml'), 'utf8')
  assert.match(qml, /command: \["\/usr\/bin\/wl-copy"\]/)
  assert.ok(!/NMP_SECRET|ev\.text|command -v|mise|nvm|"-c"/.test(qml))
  const root = { fail: message => { root.error = message } }
  const copyProc = { running: false }
  const context = { root, copyProc, Protocol: require('../protocol'), copyDeadline: { restart() {} } }
  const copy = qmlFunction(qml, 'copyCredential', context)
  const ev = { user: 'user', password: 'secret\n"$()😀' }
  copy(ev)
  assert.equal(root.pendingSecret, 'secret\n"$()😀')
  assert.equal(ev.password, '')
  assert.equal(copyProc.stdinEnabled, true)
  assert.equal(root.state, 'copying')
  const handler = qml.slice(qml.indexOf('    onStarted: {')).split('    onRunningChanged:')[0]
    .replace('    onStarted:', '')
  let written
  copyProc.write = data => { written = data }
  vm.runInNewContext(handler, context)
  assert.equal(written, 'secret\n"$()😀')
  assert.equal(root.pendingSecret, '')
  assert.equal(copyProc.stdinEnabled, false)
  root.pendingSecret = 'secret'
  copyProc.write = () => { throw new Error('write failed') }
  assert.throws(() => vm.runInNewContext(handler, context))
  assert.equal(root.pendingSecret, '')
  copyProc.running = false
  copy({ user: 'user', password: 'x'.repeat(limits.password + 1) })
  assert.ok(root.error)
  assert.equal(copyProc.running, false)
})
