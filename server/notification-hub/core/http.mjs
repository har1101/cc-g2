// HTTP response helpers + URL parsing. Pure helpers, no state, no auth logic.

export function sendJson(res, statusCode, body) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body, null, 2))
}

export function sendText(res, statusCode, body) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end(body)
}

export function sendStream(res, statusCode, contentType, stream) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', contentType)
  stream.pipe(res)
}

export function isBodyTooLargeError(err) {
  return !!err && typeof err === 'object' && 'code' in err && err.code === 'BODY_TOO_LARGE'
}

export function sendRequestBodyTooLarge(res, err) {
  const maxBytes =
    err && typeof err === 'object' && 'maxBytes' in err && Number.isFinite(err.maxBytes)
      ? err.maxBytes
      : undefined
  return sendJson(res, 413, {
    ok: false,
    error: maxBytes ? `Request body too large (max ${maxBytes} bytes)` : 'Request body too large',
  })
}

export function parseUrl(req) {
  return new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
}

function getHostname(value, assumeHttp = false) {
  try {
    if (assumeHttp) return new URL(`http://${value}`).hostname
    return new URL(value).hostname
  } catch {
    return ''
  }
}

export function isAllowedOrigin(req, allowedOrigins) {
  const origin = req.headers.origin
  if (!origin) return true
  const originHostname = getHostname(origin)
  const requestHostname = getHostname(String(req.headers.host || ''), true)
  if (!originHostname) return false
  if (originHostname === requestHostname) return true
  if (allowedOrigins.has(origin)) return true
  return false
}

export function withCorsHeaders(res) {
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CC-G2-Token')
}

export function applyCors(req, res, allowedOrigins) {
  withCorsHeaders(res)
  const origin = req.headers.origin
  if (!origin) return true
  if (!isAllowedOrigin(req, allowedOrigins)) return false
  res.setHeader('Access-Control-Allow-Origin', origin)
  return true
}
