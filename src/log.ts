import { appConfig, createHubHeaders } from './config'

/**
 * ブラウザ画面上のイベントログ
 */
export function log(message: string): void {
  const timestamp = new Date().toLocaleTimeString('ja-JP')
  const line = `[${timestamp}] ${message}`
  console.log(line)

  const logEl = document.getElementById('event-log')
  if (logEl) {
    logEl.textContent = line + '\n' + (logEl.textContent ?? '')
    // 最大100行
    const lines = logEl.textContent.split('\n')
    if (lines.length > 100) {
      logEl.textContent = lines.slice(0, 100).join('\n')
    }
  }

  // 通知フロー診断のため、通知系ログだけHubへミラーする（非同期・失敗は無視）
  if (!message.startsWith('通知')) return
  const baseUrl = appConfig.notificationHubUrl
  if (!baseUrl) return
  void fetch(`${baseUrl}/api/client-events`, {
    method: 'POST',
    headers: createHubHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      source: 'web-client',
      level: 'info',
      message: line,
      context: {
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      },
    }),
  }).catch(() => {})
}
