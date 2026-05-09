// Health service: read-only diagnostic counters surfaced by /api/health.
// Routes call this rather than reading state/store directly so the DAG
// stays clean (routes → services → state).
import * as store from '../state/store.mjs'

/**
 * @returns {{
 *   ok: true,
 *   service: 'notification-hub',
 *   notifications: number,
 *   replies: number,
 *   approvals: number,
 *   pendingApprovals: number,
 *   now: string,
 * }}
 */
export function getHealthSummary() {
  return {
    ok: true,
    service: 'notification-hub',
    notifications: store.notifications.length,
    replies: store.replies.length,
    approvals: store.approvals.length,
    pendingApprovals: store.approvals.filter((a) => a.status === 'pending').length,
    now: new Date().toISOString(),
  }
}
