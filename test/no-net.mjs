// Preload for the no-network test: any socket to a non-local address is recorded in $NONET_LOG and throws.
import { appendFileSync } from 'node:fs'
import net from 'node:net'

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', ''])
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  // net.connect passes the normalized form [options, callback].
  const a = Array.isArray(args[0]) ? args[0][0] : args[0]
  const host = typeof a === 'object' && a !== null ? (a.path ? '' : (a.host ?? 'localhost')) : typeof a === 'string' && args.length === 1 ? '' : typeof args[1] === 'string' ? args[1] : 'localhost'
  if (!LOCAL.has(String(host))) {
    appendFileSync(process.env.NONET_LOG, `${host}\n`)
    throw new Error(`blocked outgoing connection to ${host}`)
  }

  return connect.apply(this, args)
}
