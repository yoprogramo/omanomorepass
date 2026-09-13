'use strict'
// Log de diagnóstico del plugin NoMorePass. Nunca registra secretos:
// el QML redacta los mensajes antes de llamar aquí.
//
// Escribe una línea con marca de tiempo en:
//   $HOME/.local/state/omarchy/nomorepass.log
//
// El directorio de estado se crea/valida como privado (0700), propiedad del
// usuario actual y sin ningún componente simbólico. El fichero se abre con
// O_NOFOLLOW y modo 0600, de modo que un enlace simbólico preexistente no
// pueda redirigir este append automático hacia otro fichero del usuario.
// Ante cualquier anomalía no escribe nada (fail closed) y sale con código 1:
// el log es solo diagnóstico y nunca debe bloquear la recepción de credenciales.

const fs = require('node:fs')
const path = require('node:path')

const MAX_MESSAGE = 1024
const DIR_MODE = 0o700
const FILE_MODE = 0o600

function refuse() {
  process.exit(1)
}

// ISO 8601 en hora local con desplazamiento, equivalente a `date -Is`.
function timestamp(date) {
  const pad = value => String(Math.floor(Math.abs(value))).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    + sign + pad(offset / 60) + ':' + pad(offset % 60)
}

// Crea o valida un componente del directorio: debe ser un directorio real (no
// un enlace simbólico), del usuario actual y no escribible por grupo u otros.
function ensureDirectory(dir, mode, uid) {
  try {
    fs.mkdirSync(dir, { mode: mode })
  } catch (error) {
    if (error.code !== 'EEXIST') return false
  }
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false
  if (stat.uid !== uid || (stat.mode & 0o022) !== 0) return false
  // El directorio final debe quedar privado; los intermedios solo deben ser
  // inaccesibles para escritura por terceros.
  if (mode === DIR_MODE && (stat.mode & 0o077) !== 0) fs.chmodSync(dir, DIR_MODE)
  return true
}

function main() {
  const message = process.argv[2]
  if (typeof message !== 'string' || !message.length) return refuse()
  if (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE) return refuse()
  // Una línea por entrada: saltos embebidos permitirían inyectar líneas falsas.
  if (/[\u0000\r\n]/.test(message)) return refuse()

  const home = process.env.HOME
  if (!home || !path.isAbsolute(home)) return refuse()

  let realHome
  try {
    realHome = fs.realpathSync(home)
    if (!fs.lstatSync(realHome).isDirectory()) return refuse()
  } catch (error) {
    return refuse()
  }

  const uid = process.getuid()
  if (typeof uid !== 'number') return refuse()

  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND
    | fs.constants.O_NOFOLLOW
  if (typeof fs.constants.O_NOFOLLOW !== 'number') return refuse()

  try {
    const base = path.join(realHome, '.local')
    if (!ensureDirectory(base, 0o755, uid)) return refuse()
    const state = path.join(base, 'state')
    if (!ensureDirectory(state, 0o755, uid)) return refuse()
    const dir = path.join(state, 'omarchy')
    if (!ensureDirectory(dir, DIR_MODE, uid)) return refuse()

    // O_NOFOLLOW cierra la carrera del enlace simbólico: si el destino ya es
    // un symlink, openSync falla con ELOOP y no se escribe nada.
    let fd
    try {
      fd = fs.openSync(path.join(dir, 'nomorepass.log'), flags, FILE_MODE)
    } catch (error) {
      return refuse()
    }
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.uid !== uid) return refuse()
      fs.fchmodSync(fd, FILE_MODE)
      fs.writeSync(fd, timestamp(new Date()) + ' ' + message + '\n')
    } finally {
      fs.closeSync(fd)
    }
  } catch (error) {
    return refuse()
  }
}

main()
