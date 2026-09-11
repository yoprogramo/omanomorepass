'use strict'
// Synthetic input only. This probe never touches the clipboard or network.
const assert = require('node:assert/strict')
assert.equal(process.argv.length, 2)
assert.deepEqual(Object.keys(process.env).sort(), ['LANG'])
let size = 0
const chunks = []
process.stdin.on('data', chunk => {
  size += chunk.length
  assert.ok(size <= 4096)
  chunks.push(chunk)
})
process.stdin.on('end', () => {
  assert.equal(Buffer.concat(chunks).toString('utf8'), '😀'.repeat(1024))
  process.stdout.write('{"ok":true}\n')
})
