// /api/location (POST: receive Overland-style GeoJSON; GET: latest location)
import { readRequestBody, safeJsonParse } from '../notification-utils.mjs'
import { isBodyTooLargeError, sendJson, sendRequestBodyTooLarge } from '../core/http.mjs'
import { log } from '../core/log.mjs'
import { getLastLocation, setLastLocation } from '../state/store.mjs'

export async function handle(req, res, ctx) {
  const { method, pathname, deps } = ctx

  if (method === 'POST' && pathname === '/api/location') {
    let rawBody
    try {
      rawBody = await readRequestBody(req, { maxBytes: deps.hubMaxBodyBytes })
    } catch (err) {
      if (isBodyTooLargeError(err)) {
        sendRequestBodyTooLarge(res, err)
        return true
      }
      throw err
    }
    const parsed = safeJsonParse(rawBody || '{}')
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
      sendJson(res, 400, { ok: false, error: 'Invalid JSON body' })
      return true
    }
    const p = parsed.value
    // Overland GeoJSON format: { locations: [{ geometry: { coordinates: [lng, lat] }, properties: { timestamp, ... } }] }
    const locations = Array.isArray(p.locations) ? p.locations : []
    if (locations.length > 0) {
      const latest = locations[locations.length - 1]
      const coords = latest?.geometry?.coordinates
      if (!Array.isArray(coords) || coords.length < 2) {
        sendJson(res, 400, { ok: false, error: 'Invalid coordinates array' })
        return true
      }
      const lat = Number(coords[1])
      const lng = Number(coords[0])
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        sendJson(res, 400, { ok: false, error: 'Invalid latitude/longitude values' })
        return true
      }
      const alt = coords.length >= 3 ? Number(coords[2]) : NaN
      const props = latest.properties && typeof latest.properties === 'object' ? latest.properties : {}
      const spd = Number(props.speed)
      const bat = Number(props.battery_level)
      const updated = {
        lat,
        lng,
        altitude: Number.isFinite(alt) ? alt : null,
        timestamp: String(props.timestamp || '') || new Date().toISOString(),
        speed: Number.isFinite(spd) ? spd : null,
        battery: Number.isFinite(bat) ? bat : null,
        receivedAt: new Date().toISOString(),
      }
      setLastLocation(updated)
      log(`location updated: lat=${updated.lat} lng=${updated.lng}`)
    }
    sendJson(res, 200, { ok: true })
    return true
  }

  if (method === 'GET' && pathname === '/api/location') {
    const loc = getLastLocation()
    if (!loc) {
      sendJson(res, 200, { ok: true, location: null, message: 'No location data received yet' })
      return true
    }
    sendJson(res, 200, { ok: true, location: loc })
    return true
  }
  return false
}
