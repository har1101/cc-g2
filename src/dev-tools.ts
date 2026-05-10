/**
 * Dev tool buttons (Phase 1.5c).
 *
 * 旧 main.ts で直接 `document.getElementById(...).addEventListener(...)` を呼んでいた
 * dev 用ボタン (テキスト送信 / 承認デモ / マイクテスト) を 1 ファイルに集約。
 *
 * 録音/STT のロジックは behavior 不変のままここに残す (画面遷移には関与しない)。
 * 通信が必要な部分 (transcribe / glasses 描画) は dependency を `wireDevTools(deps)` で
 * 注入するので、 main.ts は wiring のみで済む。
 */

import type { BridgeConnection } from './bridge'
import type { GlassesUI } from './screens/types'
import type { AudioSession, AudioSessionHandle } from './audio-session'
import { transcribePcmChunks } from './stt/groq-batch'
import { formatForG2Display } from './g2-format'
import { resetDevAudio, store } from './state/store'
import { appConfig, canUseGroqStt } from './config'
import { getWebSpeechSupport, startWebSpeechCapture } from './stt/webspeech'

export type DevToolsDeps = {
  /** 現 connection を返す。 未接続なら null */
  getConnection: () => BridgeConnection | null
  /** audio session を返す。 未接続なら null */
  getAudioSession: () => AudioSession | null
  glassesUI: GlassesUI
  log: (msg: string) => void
}

export function wireDevTools(deps: DevToolsDeps): void {
  let currentDevAudioHandle: AudioSessionHandle | null = null
  const { getConnection, getAudioSession, glassesUI, log } = deps

  // --- Text Display ---
  const sendTextBtn = document.getElementById('send-text-btn')
  if (sendTextBtn) {
    sendTextBtn.addEventListener('click', async () => {
      const conn = getConnection()
      const text = (document.getElementById('display-text') as HTMLInputElement)?.value ?? ''
      if (!conn) {
        log('未接続です。先にConnectしてください。')
        return
      }
      log(`テキスト送信: "${text}"`)
      await glassesUI.showText(conn, text)
    })
  }

  // --- Approval UI ---
  const approvalBtn = document.getElementById('approval-btn')
  if (approvalBtn) {
    approvalBtn.addEventListener('click', async () => {
      const resultEl = document.getElementById('approval-result')!
      const conn = getConnection()
      if (!conn) {
        log('未接続です。先にConnectしてください。')
        return
      }
      resultEl.textContent = '承認待ち...'
      log('承認リクエスト送信: ファイル編集の承認')

      const result = await glassesUI.requestApproval(conn, {
        title: 'ファイル編集の承認',
        detail: 'src/auth.ts +12行/-3行',
        options: ['Approve', 'Deny'],
      })

      resultEl.textContent = `結果: ${result}`
      resultEl.classList.add(result === 'Approve' ? 'approved' : 'rejected')
      log(`承認結果: ${result}`)
    })
  }

  // --- Mic Start ---
  const micStartBtn = document.getElementById('mic-start-btn')
  if (micStartBtn) {
    micStartBtn.addEventListener('click', async () => {
      const conn = getConnection()
      const audioSession = getAudioSession()
      if (!conn || !audioSession) {
        log('未接続です。先にConnectしてください。')
        return
      }
      resetDevAudio()
      const micStatus = document.getElementById('mic-status')!
      const startBtn = document.getElementById('mic-start-btn') as HTMLButtonElement
      const stopBtn = document.getElementById('mic-stop-btn') as HTMLButtonElement
      const audioInfo = document.getElementById('audio-info')!

      store.dev.webSpeechFinalText = ''
      store.dev.webSpeechInterimText = ''
      store.dev.webSpeechError = ''
      if (appConfig.webSpeechCompare) {
        const wsCap = getWebSpeechSupport()
        if (wsCap.available) {
          try {
            store.dev.webSpeechSession = startWebSpeechCapture(({ finalText, interimText }) => {
              store.dev.webSpeechFinalText = finalText
              store.dev.webSpeechInterimText = interimText
            })
            log('Web Speech比較キャプチャ開始（ブラウザ/端末マイク系）')
          } catch (err) {
            store.dev.webSpeechSession = null
            store.dev.webSpeechError = err instanceof Error ? err.message : String(err)
            log(`Web Speech開始失敗: ${store.dev.webSpeechError}`)
          }
        }
      }

      // evenhub-simulator requires at least one created page/container before audioControl().
      if (conn.mode === 'bridge' && !glassesUI.hasRenderedPage(conn)) {
        log('マイク前にG2ベースページを初期化（simulator対策）')
        await glassesUI.ensureBasePage(conn, 'マイク録音中...')
      }

      try {
        currentDevAudioHandle = await audioSession.acquire('dev-mic')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log(`マイク開始失敗: ${msg}`)
        micStatus.textContent = `開始失敗: ${msg}`
        return
      }
      store.dev.isRecording = true
      startBtn.disabled = true
      stopBtn.disabled = false
      micStatus.textContent = '録音中...'
      audioInfo.textContent = ''
      log('マイク開始')

      currentDevAudioHandle.onPcm((pcm) => {
        if (!store.dev.isRecording) return
        store.dev.audioChunks.push(pcm)
        store.dev.audioTotalBytes += pcm.length
        const durationMs = (store.dev.audioTotalBytes / 2) / 16 // 16kHz, 16bit = 2 bytes/sample
        audioInfo.textContent = [
          `チャンク数: ${store.dev.audioChunks.length}`,
          `合計バイト: ${store.dev.audioTotalBytes}`,
          `推定時間: ${(durationMs / 1000).toFixed(1)}秒`,
          `最新チャンク: ${pcm.length} bytes`,
        ].join('\n')
      })
    })
  }

  // --- Mic Stop ---
  const micStopBtn = document.getElementById('mic-stop-btn')
  if (micStopBtn) {
    micStopBtn.addEventListener('click', async () => {
      const conn = getConnection()
      if (!conn) return
      const micStatus = document.getElementById('mic-status')!
      const startBtn = document.getElementById('mic-start-btn') as HTMLButtonElement
      const stopBtn = document.getElementById('mic-stop-btn') as HTMLButtonElement
      const audioInfo = document.getElementById('audio-info')!

      store.dev.isRecording = false
      if (currentDevAudioHandle) {
        await currentDevAudioHandle.release()
        currentDevAudioHandle = null
      }
      if (appConfig.webSpeechCompare && store.dev.webSpeechSession) {
        try {
          const ws = await store.dev.webSpeechSession.stop()
          store.dev.webSpeechFinalText = ws.finalText
          store.dev.webSpeechInterimText = ws.interimText
          if (ws.error) store.dev.webSpeechError = ws.error
          log(
            `Web Speech停止: final=${ws.finalText ? 'yes' : 'no'}, interim=${ws.interimText ? 'yes' : 'no'}${ws.error ? `, error=${ws.error}` : ''}`,
          )
        } catch (err) {
          store.dev.webSpeechError = err instanceof Error ? err.message : String(err)
          log(`Web Speech停止失敗: ${store.dev.webSpeechError}`)
        } finally {
          store.dev.webSpeechSession = null
        }
      }
      startBtn.disabled = false
      stopBtn.disabled = true

      micStatus.textContent = `録音完了 (${store.dev.audioChunks.length}チャンク, ${store.dev.audioTotalBytes}バイト)`
      log(`マイク停止: ${store.dev.audioChunks.length}チャンク, ${store.dev.audioTotalBytes}バイト取得`)

      if (store.dev.audioTotalBytes === 0) {
        return
      }

      micStatus.textContent = 'STT処理中...'
      log('STT開始')

      try {
        const stt = await transcribePcmChunks(store.dev.audioChunks)
        const formatted = formatForG2Display(stt.text || '（認識結果なし）')
        micStatus.textContent = `STT完了 (${stt.provider}${stt.model ? `:${stt.model}` : ''})`
        const infoLines = [
          audioInfo.textContent,
          '',
          `STT provider: ${stt.provider}${stt.model ? ` (${stt.model})` : ''}`,
          `STT text: ${stt.text || '（空）'}`,
        ]
        if (appConfig.webSpeechCompare) {
          const cap = getWebSpeechSupport()
          infoLines.push(
            `Web Speech API: SpeechRecognition=${cap.speechRecognition ? 'yes' : 'no'}, webkitSpeechRecognition=${cap.webkitSpeechRecognition ? 'yes' : 'no'}`,
            `Web Speech final: ${store.dev.webSpeechFinalText || '（空）'}`,
            `Web Speech interim: ${store.dev.webSpeechInterimText || '（空）'}`,
            `Web Speech error: ${store.dev.webSpeechError || 'なし'}`,
          )
        }
        infoLines.push('', 'G2表示用:', formatted)
        audioInfo.textContent = infoLines.join('\n')
        log(`STT完了: provider=${stt.provider}${stt.model ? ` model=${stt.model}` : ''}`)
        log(`STT結果: ${stt.text || '（空）'}`)
        if (appConfig.webSpeechCompare && store.dev.webSpeechFinalText) {
          log(`Web Speech結果(比較): ${store.dev.webSpeechFinalText}`)
        }
        await glassesUI.showText(conn, formatted)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        micStatus.textContent = 'STT失敗'
        log(`STT失敗: ${message}`)
        if (conn) {
          await glassesUI.showText(conn, 'STT失敗\n再試行してください')
        }
      }
    })
  }
}

/** dev tools (config / capability) のログ出力 */
export function logSpeechCapabilities(log: (msg: string) => void): void {
  if (store.dev.speechCapabilityLogged) return
  log(
    `STT設定: enabled=${appConfig.sttEnabled ? 'yes' : 'no'}, forceError=${appConfig.sttForceError ? 'yes' : 'no'}, provider=${canUseGroqStt() ? 'hub' : 'mock'}`,
  )
  if (appConfig.webSpeechCompare) {
    const cap = getWebSpeechSupport()
    log(
      `Web Speech API可否: SpeechRecognition=${cap.speechRecognition ? 'yes' : 'no'}, webkitSpeechRecognition=${cap.webkitSpeechRecognition ? 'yes' : 'no'}`,
    )
  }
  store.dev.speechCapabilityLogged = true
}
