#!/usr/bin/env node
/**
 * Small TLS reverse proxy for the DSH Web UI.
 * Keep DSH on its HTTP listener and terminate TLS here.
 */

import { createReadStream, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { parseArgs } from 'node:util'
import { createServer as createHttpsServer } from 'node:https'

const { values } = parseArgs({
  options: {
    cert: { type: 'string', required: true },
    key: { type: 'string', required: true },
    'listen-host': { type: 'string', default: '0.0.0.0' },
    'listen-port': { type: 'string', default: '8443' },
    'target-host': { type: 'string', default: '127.0.0.1' },
    'target-port': { type: 'string', default: '3080' },
  },
})

const listenPort = Number(values['listen-port'])
const targetPort = Number(values['target-port'])
if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) throw new Error('invalid --listen-port')
if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw new Error('invalid --target-port')
if (!existsSync(values.cert) || !existsSync(values.key)) throw new Error('certificate or key file does not exist')

const tlsOptions = {
  cert: await readFile(values.cert),
  key: await readFile(values.key),
}

function targetHeaders(headers) {
  const forwarded = { ...headers }
  forwarded.host = headers.host ?? `${values['target-host']}:${String(targetPort)}`
  forwarded['x-forwarded-proto'] = 'https'
  forwarded['x-forwarded-host'] = headers.host ?? ''
  return forwarded
}

const server = createHttpsServer(tlsOptions, (request, response) => {
  const upstream = httpRequest({
    host: values['target-host'],
    port: targetPort,
    method: request.method,
    path: request.url,
    headers: targetHeaders(request.headers),
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
    upstreamResponse.pipe(response)
  })
  upstream.on('error', (error) => {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' })
    response.end(`DSH upstream unavailable: ${error.message}\n`)
  })
  request.on('aborted', () => upstream.destroy())
  response.on('close', () => upstream.destroy())
  request.pipe(upstream)
})

server.on('upgrade', (request, clientSocket, head) => {
  const upstreamSocket = connect(targetPort, values['target-host'], () => {
    const headers = targetHeaders(request.headers)
    const lines = [`${request.method} ${request.url} HTTP/1.1`]
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${name}: ${item}`)
      } else if (value !== undefined) {
        lines.push(`${name}: ${value}`)
      }
    }
    upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) upstreamSocket.write(head)
    clientSocket.pipe(upstreamSocket)
    upstreamSocket.pipe(clientSocket)
  })
  upstreamSocket.on('error', () => clientSocket.destroy())
  clientSocket.on('error', () => upstreamSocket.destroy())
})

server.listen(listenPort, values['listen-host'], () => {
  console.log(`HTTPS proxy listening on https://${values['listen-host']}:${String(listenPort)}`)
  console.log(`Forwarding to http://${values['target-host']}:${String(targetPort)}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)))
}
