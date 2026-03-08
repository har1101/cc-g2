export type WebSpeechSupport = {
  available: boolean
  speechRecognition: boolean
  webkitSpeechRecognition: boolean
}

export type WebSpeechSession = {
  stop: () => Promise<{ finalText: string; interimText: string; error?: string }>
}

type SpeechCtor = new () => {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onresult: ((event: any) => void) | null
  onerror: ((event: any) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

export function getWebSpeechSupport(): WebSpeechSupport {
  const w = window as Window & {
    SpeechRecognition?: SpeechCtor
    webkitSpeechRecognition?: SpeechCtor
  }
  return {
    available: typeof w.SpeechRecognition !== 'undefined' || typeof w.webkitSpeechRecognition !== 'undefined',
    speechRecognition: typeof w.SpeechRecognition !== 'undefined',
    webkitSpeechRecognition: typeof w.webkitSpeechRecognition !== 'undefined',
  }
}

export function startWebSpeechCapture(onUpdate?: (state: { finalText: string; interimText: string }) => void): WebSpeechSession {
  const w = window as Window & {
    SpeechRecognition?: SpeechCtor
    webkitSpeechRecognition?: SpeechCtor
  }
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
  if (!Ctor) {
    throw new Error('Web Speech API unavailable')
  }

  const recognition = new Ctor()
  recognition.lang = 'ja-JP'
  recognition.continuous = true
  recognition.interimResults = true
  recognition.maxAlternatives = 1

  let finalText = ''
  let interimText = ''
  let errorMessage = ''
  let ended = false
  let resolveStop: ((value: { finalText: string; interimText: string; error?: string }) => void) | null = null

  const emit = () => onUpdate?.({ finalText: finalText.trim(), interimText: interimText.trim() })

  recognition.onresult = (event: any) => {
    interimText = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      const transcript = result?.[0]?.transcript ?? ''
      if (result?.isFinal) {
        finalText = `${finalText} ${transcript}`.trim()
      } else {
        interimText = `${interimText} ${transcript}`.trim()
      }
    }
    emit()
  }

  recognition.onerror = (event: any) => {
    errorMessage = String(event?.error ?? 'unknown')
  }

  recognition.onend = () => {
    ended = true
    if (resolveStop) {
      resolveStop({ finalText: finalText.trim(), interimText: interimText.trim(), error: errorMessage || undefined })
      resolveStop = null
    }
  }

  recognition.start()

  return {
    stop() {
      if (ended) {
        return Promise.resolve({
          finalText: finalText.trim(),
          interimText: interimText.trim(),
          error: errorMessage || undefined,
        })
      }

      return new Promise((resolve) => {
        resolveStop = resolve
        recognition.stop()
        // Some WebViews may not fire onend reliably.
        setTimeout(() => {
          if (!ended && resolveStop) {
            resolveStop({
              finalText: finalText.trim(),
              interimText: interimText.trim(),
              error: errorMessage || 'timeout',
            })
            resolveStop = null
          }
        }, 3000)
      })
    },
  }
}
