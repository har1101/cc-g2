export const G2_EVENT = {
  CLICK: 0,
  SCROLL_TOP: 1,
  SCROLL_BOTTOM: 2,
  DOUBLE_CLICK: 3,
} as const

export type EventSource = {
  eventType?: number
  currentSelectItemIndex?: number
  currentSelectItemName?: string
  containerName?: string
  jsonData?: unknown
}

export type HubEventLike = {
  listEvent?: EventSource
  textEvent?: EventSource
  sysEvent?: EventSource
  jsonData?: unknown
}

export type NormalizedG2Event = {
  eventType?: number
  kind: 'tap' | 'doubleTap' | 'scrollTop' | 'scrollBottom' | 'unknown'
  source: 'text' | 'list' | 'sys' | 'none'
  index?: number
  containerName?: string
  inferredIndex: boolean
}

function getPrimaryEventSource(event: HubEventLike): { source: NormalizedG2Event['source']; value?: EventSource } {
  if (event.textEvent) return { source: 'text', value: event.textEvent }
  if (event.listEvent) return { source: 'list', value: event.listEvent }
  if (event.sysEvent) return { source: 'sys', value: event.sysEvent }
  return { source: 'none' }
}

function extractIndexFromJsonData(jsonData: unknown): number | undefined {
  let payload = jsonData
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload)
    } catch {
      return undefined
    }
  }
  if (!payload || typeof payload !== 'object') return undefined

  const candidate = payload as Record<string, unknown>
  const nestedListEvent = candidate.listEvent
  if (nestedListEvent && typeof nestedListEvent === 'object') {
    const nestedIndex = extractIndexFromJsonData(nestedListEvent)
    if (typeof nestedIndex === 'number') return nestedIndex
  }
  const value = candidate.currentSelectItemIndex ?? candidate.index ?? candidate.selectedIndex ?? candidate.currentIndex
  return typeof value === 'number' ? value : undefined
}

/**
 * Even Hub eventType normalization.
 * Priority keeps existing behavior in this repo (text > list > sys).
 */
export function getNormalizedEventType(event: HubEventLike): number | undefined {
  return getPrimaryEventSource(event).value?.eventType
}

export function normalizeHubEvent(event: HubEventLike): NormalizedG2Event {
  const primary = getPrimaryEventSource(event)
  const eventType = primary.value?.eventType
  const directIndex = typeof event.listEvent?.currentSelectItemIndex === 'number'
    ? event.listEvent.currentSelectItemIndex
    : undefined
  const inferredIndex = directIndex === undefined
    ? extractIndexFromJsonData(event.listEvent?.jsonData) ?? extractIndexFromJsonData(event.jsonData)
    : undefined

  let kind: NormalizedG2Event['kind'] = 'unknown'
  if (eventType === G2_EVENT.CLICK) kind = 'tap'
  else if (eventType === undefined && primary.source !== 'sys') kind = 'tap'
  else if (eventType === G2_EVENT.DOUBLE_CLICK) kind = 'doubleTap'
  else if (eventType === G2_EVENT.SCROLL_TOP) kind = 'scrollTop'
  else if (eventType === G2_EVENT.SCROLL_BOTTOM) kind = 'scrollBottom'
  // Phase 5 follow-up: SDK emits an EMPTY `sysEvent: {}` (no eventType) for
  // taps on screens that don't have an active text/list container (e.g., the
  // notification-actions screen rebuilt with text-only containers). The
  // existing eventType=undefined→tap fallback only fired for text/list
  // sources, so these taps were silently ignored. Treat empty sysEvent as a
  // tap as well — same intent as the CLICK_EVENT(0) loss workaround.
  else if (
    eventType === undefined &&
    primary.source === 'sys' &&
    Object.keys(primary.value || {}).length === 0
  ) {
    kind = 'tap'
  }

  return {
    eventType,
    kind,
    source: primary.source,
    index: directIndex ?? inferredIndex,
    containerName: event.listEvent?.containerName ?? primary.value?.containerName,
    inferredIndex: directIndex === undefined && inferredIndex !== undefined,
  }
}

/**
 * SDK quirk: CLICK_EVENT(0) can be normalized to undefined on text/list payloads.
 */
export function isTapEventType(eventType: number | undefined): boolean {
  return eventType === G2_EVENT.CLICK
}

export function isDoubleTapEventType(eventType: number | undefined): boolean {
  return eventType === G2_EVENT.DOUBLE_CLICK
}
