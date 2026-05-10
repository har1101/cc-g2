// /ui (HTML approval dashboard). Token-gated when HUB_AUTH_TOKEN is set:
// the first request with ?token=... establishes a cookie session via core/auth.
import { readFile } from 'node:fs/promises'
import { getString } from '../notification-utils.mjs'
import { sendText } from '../core/http.mjs'
import { UI_SESSION, createUiSession, hasValidUiSession } from '../core/auth.mjs'

export async function handle(req, res, ctx) {
  const { method, pathname, url, deps } = ctx
  if (method !== 'GET' || (pathname !== '/ui' && pathname !== '/ui/')) return false

  if (deps.hubAuthToken) {
    const validSession = hasValidUiSession(req)
    const queryToken = getString(url.searchParams.get('token'))
    if (!validSession) {
      if (queryToken !== deps.hubAuthToken) {
        sendText(
          res,
          401,
          'Unauthorized. Open /ui?token=<HUB_AUTH_TOKEN> once to create a browser session.',
        )
        return true
      }
      const session = createUiSession()
      res.statusCode = 302
      res.setHeader(
        'Set-Cookie',
        `${UI_SESSION.cookie}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${UI_SESSION.maxAgeSec}`,
      )
      res.setHeader('Location', '/ui')
      res.end()
      return true
    }
  }
  const uiPath = new URL('../approval-ui.html', import.meta.url)
  const html = await readFile(uiPath, 'utf8')
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(html)
  return true
}
