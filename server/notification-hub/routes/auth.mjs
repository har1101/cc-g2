// /api/auth-check (token sanity probe)
import { sendJson } from '../core/http.mjs'

export async function handle(req, res, ctx) {
  if (ctx.method !== 'GET' || ctx.pathname !== '/api/auth-check') return false
  // The dispatcher already enforced requireApiAuth for non-public /api/* paths,
  // so reaching this handler implies the caller is authorized.
  sendJson(res, 200, { ok: true })
  return true
}
