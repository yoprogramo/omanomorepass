// nmp-helper.js — puente Node entre el shell de Omarchy y la API de
// nomorepass.com (protocolo 2, flujo de recepción).
//
// Implementa el mismo protocolo que la lib `nomorepass` (getid.php → QR →
// polling de check.php → descifrado AES con el token del QR) pero registrando
// cada intento de sondeo, para que el log muestre si está esperando, qué
// responde el servidor en cada ciclo, y cuándo llega el grant del móvil.
//
// Protocolo en stdout (un JSON por línea):
//   {"event":"status","state":"requesting"}
//   {"event":"qr","image":"<bounded base64 PNG>"}
//   {"event":"credentials","user":"...","password":"..."}
//   {"event":"denied"} | {"event":"expired"} | {"event":"timeout"}
//   {"event":"error","message":"..."}
//
// Diagnóstico por stderr (el QML lo redirige al log, ya redactado):
//   intento 7: esperando escaneo… / error de red (…) / respuesta anómala (…)
//
// Uso: node nmp-helper.js [--site <site>] [--timeout <segundos>] [--apikey <key>]
// La apikey por defecto es la FREEAPIKEY de la propia lib.

'use strict'

const { randomInt } = require('crypto')
const { spawnSync } = require('node:child_process')
const { limits, boundedString, schema, validEvent } = require('./protocol')
const axios = require('axios')
const FormData = require('form-data')
const CryptoJS = require('crypto-js')

const API = 'https://api.nomorepass.com/api'

function send(obj, done) {
  if (!validEvent(obj)) throw new Error('Invalid helper event')
  // ASCII framing also keeps arbitrary pipe chunk boundaries UTF-8 safe.
  const line = JSON.stringify(obj).replace(/[\u007f-\uffff]/g,
    ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
  if (line.length > limits.line) throw new Error('Helper output overflow')
  process.stdout.write(line + '\n', done)
}

// Drain the final event before exiting: JSON escaping can expand a bounded
// credential beyond the pipe's capacity.
function finish(obj, code = 0) {
  send(obj, () => process.exit(code))
}

function log(msg) {
  process.stderr.write('[nmp] ' + msg + '\n')
}

function parseArgs(argv) {
  const opts = { site: 'omarchy', timeout: 90, apikey: process.env.NMP_APIKEY || '' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--site') opts.site = argv[++i]
    else if (argv[i] === '--timeout') opts.timeout = parseInt(argv[++i], 10) || 90
    else if (argv[i] === '--apikey') opts.apikey = argv[++i]
  }
  if (opts.timeout <= 0 || opts.timeout > 2147483) opts.timeout = 90
  if (process.env.NMP_SITE) opts.site = process.env.NMP_SITE
  if (!boundedString(opts.site, limits.site, true) || /[\u0000-\u001f\u007f]/.test(opts.site))
    throw new Error('Invalid site (maximum 256 UTF-8 bytes)')
  if (!boundedString(opts.apikey, 256, false) || /[\r\n\0]/.test(opts.apikey))
    throw new Error('Invalid API key')
  if (opts.timeout > 900) opts.timeout = 900
  return opts
}

function validateTicket(data) {
  if (!schema(data, ['resultado', 'ticket'], []) || data.resultado !== 'ok'
      || !boundedString(data.ticket, limits.ticket, true) || !/^[A-Za-z0-9_-]+$/.test(data.ticket))
    throw new Error('Invalid ticket response')
  return data.ticket
}

function validatePoll(data) {
  if (!schema(data, ['resultado', 'grant'], ['usuario', 'password', 'extra'])
      || data.resultado !== 'ok' || !['waiting', 'grant', 'deny', 'expired'].includes(data.grant))
    throw new Error('Invalid polling response')
  for (const [key, max] of [['usuario', limits.user], ['password', limits.encrypted], ['extra', limits.extra]]) {
    if (Object.prototype.hasOwnProperty.call(data, key) && !boundedString(data[key], max, false))
      throw new Error('Invalid credential field')
  }
  if (data.grant === 'grant') {
    if (!boundedString(data.usuario, limits.user, false)
        || !boundedString(data.password, limits.encrypted, true)
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.password) || data.password.length % 4 !== 0)
      throw new Error('Invalid encrypted credential')
    const encrypted = Buffer.from(data.password, 'base64')
    if (encrypted.toString('base64') !== data.password || encrypted.length < 32
        || encrypted.length > 4128 || encrypted.length % 16 !== 0
        || encrypted.subarray(0, 8).toString('ascii') !== 'Salted__')
      throw new Error('Invalid encrypted credential')
  }
  return data
}

function renderQr(text) {
  if (!boundedString(text, limits.qr, true) || !text.startsWith('nomorepass://') || text.includes('\0'))
    throw new Error('Invalid QR payload')
  // No shell, PATH lookup, argv payload, environment payload, or temporary file.
  const result = spawnSync('/usr/bin/qrencode', ['-o', '-', '-t', 'PNG', '-s', '10', '-m', '2'], {
    input: Buffer.from(text, 'utf8'), env: { LANG: 'C.UTF-8' },
    timeout: 3000, killSignal: 'SIGKILL', maxBuffer: limits.png
  })
  if (result.error || result.status !== 0 || !result.stdout || result.stdout.length > limits.png
      || result.stdout.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
    throw new Error('Could not render the QR code (/usr/bin/qrencode required)')
  return result.stdout.toString('base64')
}

// Token de 12 caracteres alfanuméricos, igual que nmp_newtoken() de la lib:
// ~71 bits de entropía, sin sesgo y con el formato fijo del protocolo.
// Es la passphrase con la que la app cifra la contraseña para este envío.
function newToken() {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let out = ''
  for (let i = 0; i < 12; i++) out += charset.charAt(randomInt(charset.length))
  return out
}

async function post(path, params, apikey, cancelToken) {
  const fd = new FormData()
  for (const name in params) fd.append(name, params[name])
  const headers = fd.getHeaders()
  headers.apikey = apikey || 'FREEAPIKEY'
  const res = await axios.post(API + path, fd, {
    headers,
    timeout: 10000,
    maxContentLength: limits.response,
    maxBodyLength: 64 * 1024,
    maxRedirects: 3,
    cancelToken
  })
  return res.data
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  // Cubre también getid.php y cancela cualquier petición en curso.
  const cancellation = axios.CancelToken.source()
  let stopped = false
  setTimeout(() => {
    stopped = true
    cancellation.cancel('Tiempo de espera agotado')
    log('scan timed out')
    finish({ event: 'timeout' })
  }, opts.timeout * 1000)
  send({ event: 'status', state: 'requesting' })

  // 1. Ticket para este envío.
  let data
  try {
    data = await post('/getid.php', { site: opts.site }, opts.apikey, cancellation.token)
  } catch (e) {
    return finish({ event: 'error', message: 'Could not request a ticket from api.nomorepass.com' }, 1)
  }
  let ticket
  try { ticket = validateTicket(data) } catch (e) {
    return finish({ event: 'error', message: 'Invalid ticket response' }, 1)
  }

  const token = newToken()
  send({ event: 'qr', image: renderQr('nomorepass://' + token + ticket + opts.site) })
  log('ticket ready; polling every 3s')

  // 2. Sondeo de check.php: waiting → seguimos; grant → descifrar; deny/expired → fin.
  let attempt = 0
  const schedule = () => { if (!stopped) setTimeout(poll, 3000) }

  const poll = async () => {
    attempt++
    let resp
    try {
      resp = await post('/check.php', { ticket }, opts.apikey, cancellation.token)
    } catch (e) {
      if (e.code === 'ERR_BAD_RESPONSE' || /maxContentLength/.test(e.message || '')) {
        return finish({ event: 'error', message: 'Invalid or oversized API response' }, 1)
      }
      log('attempt ' + attempt + ': network error')
      schedule()
      return
    }
    try { validatePoll(resp) } catch (e) {
      return finish({ event: 'error', message: 'Invalid polling response' }, 1)
    }
    const grant = resp.grant
    if (grant === 'grant') {
      log('attempt ' + attempt + ': credentials received')
      let pass = ''
      try {
        pass = CryptoJS.AES.decrypt(resp.password, token).toString(CryptoJS.enc.Utf8)
        if (!boundedString(pass, limits.password, false)) throw new Error('Credential overflow')
      } catch (e) {
        return finish({ event: 'error', message: 'Could not decrypt the credential' }, 1)
      }
      finish({ event: 'credentials', user: resp.usuario, password: pass })
      pass = ''
      resp.password = ''
    } else if (grant === 'deny') {
      log('attempt ' + attempt + ': denied')
      finish({ event: 'denied' })
    } else if (grant === 'expired') {
      log('attempt ' + attempt + ': expired')
      finish({ event: 'expired' })
    } else {
      log('attempt ' + attempt + ': waiting')
      schedule()
    }
  }
  schedule()
}

if (require.main === module) main().catch((e) => {
  finish({ event: 'error', message: 'NoMorePass helper failed; check system dependencies and input limits' }, 1)
})

module.exports = { newToken, post, parseArgs, main, validateTicket, validatePoll, renderQr, send, finish }
