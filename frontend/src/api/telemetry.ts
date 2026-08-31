// Fire-and-forget client instrumentation for the citation video lifecycle
// (request start → presigned URL → ready-to-play, plus stalls / errors / retries).
//
// Sent with navigator.sendBeacon so it survives navigation and never blocks the
// UI. The payload goes as text/plain, which keeps it a CORS "simple request"
// (no preflight) against POST /telemetry/video. This must never throw — telemetry
// failing is not allowed to affect playback.

const API_BASE = (import.meta.env['VITE_API_BASE_URL'] as string).replace(/\/$/, '');

interface Base {
  clientId: string;
  videoId: string;
  attempt: number;
}

export type VideoEvent =
  | ({ event: 'url_requested' } & Base)
  | ({ event: 'url_received'; ms: number } & Base)
  | ({ event: 'url_failed'; ms: number; status: number } & Base)
  | ({ event: 'media_ready'; msSinceUrl: number; msTotal: number } & Base)
  | ({ event: 'stalled'; stage: 'url' | 'media'; msTotal: number } & Base)
  | ({ event: 'media_error'; code: number; msTotal: number } & Base)
  | ({ event: 'retry' } & Base);

export function reportVideoEvent(payload: VideoEvent): void {
  // Structured console line so timings are visible live during a demo.
  try {
    console.info('[video-timing]', payload);
  } catch {
    /* ignore */
  }

  try {
    const url = `${API_BASE}/telemetry/video`;
    const body = JSON.stringify(payload);
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
      return;
    }
    void fetch(url, {
      method: 'POST',
      body,
      keepalive: true,
      headers: { 'Content-Type': 'text/plain' },
    }).catch(() => {
      /* ignore */
    });
  } catch {
    /* telemetry must never break playback */
  }
}
