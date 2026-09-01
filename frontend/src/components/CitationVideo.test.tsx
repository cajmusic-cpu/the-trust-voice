import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import * as client from '../api/client';
import { CitationVideo } from './QueryInterface';

// Telemetry is fire-and-forget; stub it so tests don't hit the network.
vi.mock('../api/telemetry', () => ({ reportVideoEvent: vi.fn() }));

// CitationVideo needs no auth — stub the module so importing api/client does not
// construct a real Cognito user pool at load time.
vi.mock('../auth/cognito', () => ({ getIdToken: vi.fn().mockResolvedValue('test-token') }));

const GOOD_URL = 'https://videos.example.test/optimized.mp4?X-Amz-Signature=ok';

function abortableNever(signal?: AbortSignal): Promise<string> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () =>
      reject(new DOMException('The operation was aborted.', 'AbortError')),
    );
  });
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function videoEl(): HTMLVideoElement | null {
  return document.querySelector('video.citation-video');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup();
});

describe('CitationVideo — failure surfaces a retry affordance and recovers in place', () => {
  it('URL fetch that hangs past the 10s timeout → "Still loading… / Retry", then retry recovers', async () => {
    let calls = 0;
    vi.spyOn(client, 'getVideoUrl').mockImplementation((_c, _v, signal) => {
      calls += 1;
      return calls === 1 ? abortableNever(signal) : Promise.resolve(GOOD_URL);
    });

    render(<CitationVideo clientId="c-timeout" videoId="v-timeout" startTime={10} endTime={20} />);

    // Starts as a plain spinner, no retry button.
    expect(document.querySelector('.citation-video-spinner')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();

    // Cross the 10s URL-fetch timeout.
    await flush(10_001);

    expect(screen.getByText('Still loading…')).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'Retry' });

    // Retry: no unmount, no navigation — same component instance.
    fireEvent.click(retry);
    await flush();

    expect(screen.queryByText('Still loading…')).toBeNull();
    const video = videoEl();
    expect(video).not.toBeNull();
    expect(video?.getAttribute('src')).toContain('optimized.mp4');
    expect(calls).toBe(2);
  });

  it('media-load watchdog: URL resolves but no playable frame in 10s → "Still loading… / Retry"', async () => {
    vi.spyOn(client, 'getVideoUrl').mockResolvedValue(GOOD_URL);

    render(<CitationVideo clientId="c-media" videoId="v-media" startTime={0} endTime={5} />);
    await flush(); // resolve the URL → loading_media, <video> mounts

    expect(videoEl()).not.toBeNull();
    expect(document.querySelector('.citation-video-spinner')).not.toBeNull();

    await flush(10_001); // media watchdog fires

    expect(screen.getByText('Still loading…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('<video> element error (e.g. expired presigned URL) → "This clip didn\'t load. / Retry", retry re-mounts it', async () => {
    vi.spyOn(client, 'getVideoUrl').mockResolvedValue(GOOD_URL);

    render(<CitationVideo clientId="c-err" videoId="v-err" startTime={3} endTime={7} />);
    await flush();

    const video = videoEl();
    expect(video).not.toBeNull();

    fireEvent.error(video as HTMLVideoElement);

    expect(screen.getByText("This clip didn't load.")).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'Retry' });

    fireEvent.click(retry);
    await flush();

    expect(screen.queryByText("This clip didn't load.")).toBeNull();
    expect(videoEl()).not.toBeNull();
  });

  it('permanent failure (HTTP 403) → "This clip isn\'t available." with no Retry', async () => {
    vi.spyOn(client, 'getVideoUrl').mockRejectedValue(new client.ApiError('forbidden', 403));

    render(<CitationVideo clientId="c-403" videoId="v-403" startTime={0} endTime={4} />);
    await flush();

    expect(screen.getByText("This clip isn't available.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('transient HTTP 500 → retryable "Still loading… / Retry"', async () => {
    let calls = 0;
    vi.spyOn(client, 'getVideoUrl').mockImplementation(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new client.ApiError('server error', 500))
        : Promise.resolve(GOOD_URL);
    });

    render(<CitationVideo clientId="c-500" videoId="v-500" startTime={0} endTime={4} />);
    await flush();

    expect(screen.getByText('Still loading…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await flush();

    expect(screen.queryByText('Still loading…')).toBeNull();
    expect(videoEl()).not.toBeNull();
    expect(calls).toBe(2);
  });

  // Regression: an opacity:0 <video> is a stacking context painted in tree
  // order at the z-index:0 level. It renders AFTER the retry overlay in the
  // DOM, so without the CSS guards below it painted on top and swallowed
  // clicks on the Retry button (invisible, but pointer-events still active).
  // jsdom has no hit-testing, so the behavioural tests above cannot catch it —
  // assert the computed styles that keep the overlay reachable instead.
  it('retry overlay stays above and the not-ready <video> ignores pointer input', async () => {
    vi.spyOn(client, 'getVideoUrl').mockResolvedValue(GOOD_URL);

    render(<CitationVideo clientId="c-stack" videoId="v-stack" startTime={2} endTime={6} />);
    await flush();

    const video = videoEl();
    expect(video).not.toBeNull();
    fireEvent.error(video as HTMLVideoElement); // -> status 'error', overlay + <video> both mounted

    const overlay = document.querySelector('.citation-video-loading.citation-video-retry');
    expect(overlay).not.toBeNull();

    expect(getComputedStyle(overlay as Element).zIndex).toBe('3');
    expect(getComputedStyle(video as Element).pointerEvents).toBe('none');
  });
});
