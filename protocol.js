// Shared by Node and QML. Limits are UTF-8 bytes unless explicitly named.
var limits = Object.freeze({
  site: 256, ticket: 128, qr: 512, user: 512, password: 4096,
  encrypted: 5528, extra: 4096, message: 256,
  response: 64 * 1024, png: 64 * 1024, image: 87384,
  line: 96 * 1024, output: 128 * 1024, events: 4,
  stderrLine: 512, stderrOutput: 128 * 1024
})

function boundedString(value, max, nonempty) {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.length)) return false
  try { return encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, 'x').length <= max }
  catch (e) { return false } // Reject unpaired UTF-16 surrogates.
}

function schema(value, required, optional) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  var keys = Object.keys(value)
  if (keys.length > required.length + optional.length) return false
  return required.every(function(key) { return Object.prototype.hasOwnProperty.call(value, key) })
    && keys.every(function(key) { return required.indexOf(key) !== -1 || optional.indexOf(key) !== -1 })
}

function validEvent(ev) {
  if (!ev || typeof ev.event !== 'string') return false
  switch (ev.event) {
  case 'status': return schema(ev, ['event', 'state'], []) && ev.state === 'requesting'
  case 'qr': return schema(ev, ['event', 'image'], [])
    && boundedString(ev.image, limits.image, true)
    && /^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(ev.image) && ev.image.length % 4 === 0
  case 'credentials': return schema(ev, ['event', 'user', 'password'], [])
    && boundedString(ev.user, limits.user, false) && boundedString(ev.password, limits.password, false)
  case 'error': return schema(ev, ['event', 'message'], []) && boundedString(ev.message, limits.message, true)
  case 'denied': case 'expired': case 'timeout': return schema(ev, ['event'], [])
  default: return false
  }
}

// SplitParser with an empty delimiter supplies chunks, not buffered lines.
// Check both budgets before retaining any partial line. A failed stream stays failed.
function lineStream(maxLine, maxOutput, maxLines) {
  return { buffer: '', total: 0, count: 0, failed: false,
    push: function(chunk, read) {
      if (this.failed) return false
      if (!boundedString(chunk, maxOutput - this.total, false)) return this.fail()
      this.total += encodeURIComponent(chunk).replace(/%[0-9A-F]{2}/g, 'x').length
      var start = 0
      while (start < chunk.length) {
        var end = chunk.indexOf('\n', start)
        var part = chunk.slice(start, end === -1 ? chunk.length : end)
        if (this.buffer.length + part.length > maxLine) return this.fail()
        this.buffer += part
        if (!boundedString(this.buffer, maxLine, false)) return this.fail()
        if (end === -1) break
        if (++this.count > maxLines) return this.fail()
        var line = this.buffer
        this.buffer = ''
        read(line)
        line = ''
        if (this.failed) return false
        start = end + 1
      }
      return true
    },
    fail: function() { this.buffer = ''; this.failed = true; return false },
    finish: function() { return !this.failed && this.buffer === '' }
  }
}

if (typeof module !== 'undefined') module.exports = { limits, boundedString, schema, validEvent, lineStream }
