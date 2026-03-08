import { describe, expect, it } from 'vitest'
import { G2_EVENT, getNormalizedEventType, normalizeHubEvent } from '../src/even-events'

describe('even-events', () => {
  it('prefers text event type over list/sys to keep current routing semantics', () => {
    expect(getNormalizedEventType({
      textEvent: { eventType: G2_EVENT.DOUBLE_CLICK },
      listEvent: { eventType: G2_EVENT.SCROLL_TOP },
      sysEvent: { eventType: G2_EVENT.SCROLL_BOTTOM },
    })).toBe(G2_EVENT.DOUBLE_CLICK)
  })

  it('treats missing eventType as tap and keeps list container metadata', () => {
    const normalized = normalizeHubEvent({
      listEvent: {
        containerName: 'notif-list',
        currentSelectItemIndex: 2,
      },
    })

    expect(normalized.kind).toBe('tap')
    expect(normalized.source).toBe('list')
    expect(normalized.index).toBe(2)
    expect(normalized.containerName).toBe('notif-list')
    expect(normalized.inferredIndex).toBe(false)
  })

  it('treats sys events without eventType as unknown', () => {
    const normalized = normalizeHubEvent({
      sysEvent: {},
    })

    expect(normalized.kind).toBe('unknown')
    expect(normalized.source).toBe('sys')
  })

  it('recovers index from jsonData when the sdk omits currentSelectItemIndex', () => {
    const normalized = normalizeHubEvent({
      listEvent: {
        eventType: G2_EVENT.CLICK,
        jsonData: '{"currentSelectItemIndex":1}',
      },
    })

    expect(normalized.kind).toBe('tap')
    expect(normalized.index).toBe(1)
    expect(normalized.inferredIndex).toBe(true)
  })
})
