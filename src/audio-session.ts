/**
 * Exclusive audio-session ownership (Phase 1.5b).
 *
 * 元の main.ts では `replyIsRecording` / `voiceCommandIsRecording` /
 * `isRecording` の 3 つの module-global flag を `connection.onAudio` の中で
 * 「reply > voice > dev」の順で if-else 分岐していた。 Phase 1.5b では
 * 「同時に1人の owner だけが PCM を受け取る」 を構造的に保証する。
 *
 * - PCM listener は audio-session が `connection.onAudio` に 1 度だけ登録する。
 * - `acquire(owner)` で hand-out された handle のみ PCM を購読できる。
 * - 別 owner が保持中に `acquire()` すると `Error('audio-busy: <owner>')` で reject。
 * - `release()` は `connection.stopAudio()` を呼び、 listener を解除する。
 *
 * 「reply 録音が voice より優先」 の implicit precedence は、
 * 呼び出し側が acquire 失敗を check して bail-out する明示的なフローに置き換える。
 */

export type AudioOwner = 'idle' | 'reply-comment' | 'voice-command' | 'dev-mic'

export type AudioSessionHandle = {
  /** 現 handle が active な間だけ PCM を受信。 release 後の subscriber 呼び出しは無視される */
  onPcm(handler: (pcm: Uint8Array) => void): void
  /** stopAudio() を呼び、 ownership を解放する。 idempotent */
  release(): Promise<void>
}

export type AudioSession = {
  /** 現在の owner。 解放されていれば 'idle' */
  current(): AudioOwner
  /**
   * 排他取得。 別 owner が保持中なら reject。
   * `startAudio()` 中に例外が起きた場合も内部 state を idle に戻す。
   */
  acquire(owner: Exclude<AudioOwner, 'idle'>): Promise<AudioSessionHandle>
}

export type AudioSessionDeps = {
  /** Bridge への startAudio()。 通常 `connection.startAudio` を渡す */
  startAudio: () => Promise<void>
  /** Bridge への stopAudio()。 通常 `connection.stopAudio` を渡す */
  stopAudio: () => Promise<void>
  /** PCM listener 登録。 通常 `connection.onAudio` を渡す。 attach 時に一度だけ呼ばれる */
  onAudio: (handler: (pcm: Uint8Array) => void) => void
}

export function createAudioSession(deps: AudioSessionDeps): AudioSession {
  let current: AudioOwner = 'idle'
  // 取得処理が in-flight (startAudio 中) かを示す。 リエントラントな acquire を弾く
  let acquireInFlight: AudioOwner | null = null
  // active な handle が登録した PCM subscriber。 release 時にクリアする
  let activeSubscriber: ((pcm: Uint8Array) => void) | null = null

  // PCM listener は 1 度だけ登録する。 register 時の owner check は dispatch 時に行う
  deps.onAudio((pcm) => {
    if (!activeSubscriber) return
    activeSubscriber(pcm)
  })

  async function acquire(owner: Exclude<AudioOwner, 'idle'>): Promise<AudioSessionHandle> {
    if (current !== 'idle' || acquireInFlight) {
      const blocker = acquireInFlight ?? current
      throw new Error(`audio-busy: ${blocker}`)
    }
    acquireInFlight = owner
    try {
      await deps.startAudio()
    } catch (err) {
      // startAudio 失敗時は idle に戻す。 caller には例外を再 throw
      acquireInFlight = null
      throw err
    }
    // 成功してから ownership を確定し、 in-flight を解除
    current = owner
    acquireInFlight = null

    let released = false
    // この handle 用の subscriber slot。 onPcm が呼ばれるまで activeSubscriber は null のまま
    let mySubscriber: ((pcm: Uint8Array) => void) | null = null

    const handle: AudioSessionHandle = {
      onPcm(handler) {
        if (released) return
        mySubscriber = handler
        activeSubscriber = handler
      },
      async release() {
        if (released) return
        released = true
        // 自身が現 active subscriber の場合のみ clear する。
        // 仮に release 後に再 acquire された後の subscriber を間違って消すのを防ぐ
        if (activeSubscriber === mySubscriber) {
          activeSubscriber = null
        }
        try {
          await deps.stopAudio()
        } finally {
          // stopAudio が失敗しても ownership は idle に戻す。
          // (再 acquire できないと UI が永久に "audio-busy" になってしまうため)
          if (current === owner) {
            current = 'idle'
          }
        }
      },
    }
    return handle
  }

  return {
    current: () => current,
    acquire,
  }
}
