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
//   {"event":"qr","text":"nomorepass://<token><ticket><site>"}
//   {"event":"credentials","user":"...","password":"...","extra":"..."}
//   {"event":"denied"} | {"event":"expired"} | {"event":"timeout"}
//   {"event":"error","message":"..."}
//
// Diagnóstico por stderr (el QML lo redirige al log, ya redactado):
//   intento 7: esperando escaneo… / error de red (…) / respuesta anómala (…)
//
// Uso: node nmp-helper.js [--site <site>] [--timeout <segundos>] [--apikey <key>]
// La apikey por defecto es la FREEAPIKEY de la propia lib.

'use strict'

const axios = require('axios')
const FormData = require('form-data')
const CryptoJS = require('crypto-js')

const API = 'https://api.nomorepass.com/api'

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
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
  if (process.env.NMP_SITE) opts.site = process.env.NMP_SITE
  return opts
}

// Token de 12 caracteres alfanuméricos, igual que nmp_newtoken() de la lib:
// es la passphrase con la que la app cifra la contraseña para este envío.
function newToken() {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let out = ''
  for (let i = 0; i < 12; i++) out += charset.charAt(Math.floor(Math.random() * charset.length))
  return out
}

async function post(path, params, apikey) {
  const fd = new FormData()
  for (const name in params) fd.append(name, params[name])
  const headers = fd.getHeaders()
  headers.apikey = apikey || 'FREEAPIKEY'
  const res = await axios.post(API + path, fd, { headers })
  return res.data
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  send({ event: 'status', state: 'requesting' })

  // 1. Ticket para este envío.
  let data
  try {
    data = await post('/getid.php', { site: opts.site }, opts.apikey)
  } catch (e) {
    send({ event: 'error', message: 'Sin conexión con api.nomorepass.com (' + e.message + ')' })
    process.exit(1)
  }
  if (!data || data.resultado !== 'ok' || !data.ticket) {
    send({ event: 'error', message: 'getid: ' + JSON.stringify(data).slice(0, 200) })
    process.exit(1)
  }

  const token = newToken()
  const ticketFp = data.ticket.substring(0, 6) + "…"
  send({ event: 'qr', text: 'nomorepass://' + token + data.ticket + opts.site })
  log('ticket ' + ticketFp + ' listo (site=' + opts.site + '), sondeando cada 3s (timeout ' + opts.timeout + 's)')

  // 2. Sondeo de check.php: waiting → seguimos; grant → descifrar; deny/expired → fin.
  let attempt = 0
  let stopped = false
  const schedule = () => { if (!stopped) setTimeout(poll, 3000) }

  const poll = async () => {
    attempt++
    let resp
    try {
      resp = await post('/check.php', { ticket: data.ticket }, opts.apikey)
    } catch (e) {
      log('intento ' + attempt + ': error de red (' + e.message + ')')
      schedule()
      return
    }
    if (!resp || resp.resultado !== 'ok') {
      log('intento ' + attempt + ': respuesta anómala ' + JSON.stringify(resp).slice(0, 120))
      schedule()
      return
    }
    const grant = resp.grant
    if (grant === 'grant') {
      log('intento ' + attempt + ': credenciales recibidas ✓')
      let pass = ''
      try {
        pass = CryptoJS.AES.decrypt(resp.password, token).toString(CryptoJS.enc.Utf8)
      } catch (e) {
        log('aviso: descifrado vacío (' + e + ')')
      }
      send({ event: 'credentials', user: resp.usuario || '', password: pass, extra: resp.extra || '' })
      process.exit(0)
    } else if (grant === 'deny') {
      log('intento ' + attempt + ': envío rechazado desde el móvil')
      send({ event: 'denied' })
      process.exit(0)
    } else if (grant === 'expired') {
      log('intento ' + attempt + ': el ticket ha expirado en el servidor')
      send({ event: 'expired' })
      process.exit(0)
    } else {
      log('intento ' + attempt + ' [ticket ' + ticketFp + ']: esperando escaneo…')
      schedule()
    }
  }
  schedule()

  // 3. Timeout global.
  setTimeout(() => {
    stopped = true
    log('tiempo de espera agotado sin escaneo')
    send({ event: 'timeout' })
    process.exit(0)
  }, opts.timeout * 1000)
}

main().catch((e) => {
  send({ event: 'error', message: String(e && e.message ? e.message : e) })
  process.exit(1)
})
