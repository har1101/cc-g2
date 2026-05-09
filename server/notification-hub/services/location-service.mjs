// Location service: owns the latest-location state slot.
// Validates Overland-style GeoJSON payloads and exposes simple read access.
// May call: state/store, core/log.
import { log } from '../core/log.mjs'
import { getLastLocation, setLastLocation } from '../state/store.mjs'

/**
 * Outcome:
 *   - { ok: true, updated: false } — empty `locations` array; nothing to do.
 *   - { ok: true, updated: true }  — latest location stored.
 *   - { ok: false, error }         — validation failure.
 *
 * @param {any} payload - already-parsed JSON body
 * @returns {{ ok: true, updated: boolean } | { ok: false, error: string }}
 */
export function ingestOverlandPayload(payload) {
  const p = (payload && typeof payload === 'object') ? payload : {}
  const locations = Array.isArray(p.locations) ? p.locations : []
  if (locations.length === 0) {
    return { ok: true, updated: false }
  }
  const latest = locations[locations.length - 1]
  const coords = latest?.geometry?.coordinates
  if (!Array.isArray(coords) || coords.length < 2) {
    return { ok: false, error: 'Invalid coordinates array' }
  }
  const lat = Number(coords[1])
  const lng = Number(coords[0])
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { ok: false, error: 'Invalid latitude/longitude values' }
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
  return { ok: true, updated: true }
}

export function getLatestLocation() {
  return getLastLocation()
}
