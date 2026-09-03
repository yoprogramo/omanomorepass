// nmp-helper.js — puente Node entre el shell de Omarchy y la lib nomorepass.
//
// Protocolo en stdout (un JSON por línea):
//   {"event":"status","state":"requesting"}
//   {"event":"qr","text":"nomorepass://<token><ticket><site>"}
//   {"event":"credentials","user":"...","password":"...","extra":"..."}
//   {"event":"denied"} | {"event":"expired"} | {"event":"timeout"}
//   {"event":"error","message":"..."}
//
// Uso: node nmp-helper.js [--site <site>] [--timeout <segundos>] [--apikey <key>]
// La apikey por defecto es la FREEAPIKEY de la propia lib.

'use strict'

const nmp = require('nomorepass')

// La lib llama a alert() cuando la API responde con error; en Node no existe.
global.alert = function (msg) {
  send({ event: 'error', message: String(msg) })
  process.exit(1)
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
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

const opts = parseArgs(process.argv.slice(2))

if (opts.apikey) nmp.init({ apikey: opts.apikey })
else nmp.init({})

send({ event: 'status', state: 'requesting' })

nmp.getQrText(opts.site, function (text) {
  if (!text) {
    send({ event: 'error', message: 'No se pudo obtener el ticket de nomorepass (¿sin conexión a api.nomorepass.com?)' })
    process.exit(1)
  }
  send({ event: 'qr', text: text })
  nmp.start(function (error, data) {
    clearTimeout(killTimer)
    if (error) {
      if (data === 'denied') send({ event: 'denied' })
      else if (data === 'expired') send({ event: 'expired' })
      else send({ event: 'error', message: String(data) })
    } else {
      send({ event: 'credentials', user: data.user || '', password: data.password || '', extra: data.extra || '' })
    }
    process.exit(error ? 1 : 0)
  })
})

const killTimer = setTimeout(function () {
  nmp.stop()
  send({ event: 'timeout' })
  process.exit(0)
}, opts.timeout * 1000)
