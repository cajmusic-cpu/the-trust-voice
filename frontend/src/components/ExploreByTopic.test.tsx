import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import * as client from '../api/client';
import { ExploreByTopic } from './ExploreByTopic';
import type { TopicGroup } from '../api/client';

// Telemetry is fire-and-forget; stub it so tests don't hit the network.
vi.mock('../api/telemetry', () => ({ reportVideoEvent: vi.fn() }));

// Neither ExploreByTopic nor the CitationVideo it renders need real auth —
// stub the module so importing api/client does not construct a real Cognito
// user pool at load time (same pattern as CitationVideo.test.tsx).
vi.mock('../auth/cognito', () => ({
  getIdToken: vi.fn().mockResolvedValue('test-token'),
  signOut: vi.fn(),
}));

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

const THEMES: TopicGroup[] = [
  {
    key: 'wealth_purpose',
    section: 'Wealth Philosophy',
    label: 'What wealth is ultimately for',
    count: 1,
    items: [
      { videoId: 'vid-1', startTime: 10, endTime: 40, speaker: 'spk_0', quote: 'Wealth is for building, not hoarding.' },
    ],
  },
  {
    key: 'forgiveness',
    section: 'Family',
    label: 'Forgiveness and repairing family rifts',
    count: 0,
    items: [],
  },
];

beforeEach(() => {
  vi.spyOn(client, 'getVideoUrl').mockResolvedValue('https://videos.example.test/clip.mp4');
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('ExploreByTopic', () => {
  it('renders every section and theme with its count once topics load', async () => {
    vi.spyOn(client, 'getTopics').mockResolvedValue(THEMES);

    render(
      <ExploreByTopic
        clientId="client-1"
        clientName="Lisa Satterfield"
        onSignOut={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    await flush();

    expect(screen.getByText('Wealth Philosophy')).toBeTruthy();
    expect(screen.getByText('Family')).toBeTruthy();
    expect(screen.getByText('What wealth is ultimately for')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy(); // count badge for the tagged theme
    expect(screen.getByText('0')).toBeTruthy(); // count badge for the empty theme
  });

  it('expanding a theme with content shows its citation, collapsed by default', async () => {
    vi.spyOn(client, 'getTopics').mockResolvedValue(THEMES);

    render(
      <ExploreByTopic
        clientId="client-1"
        clientName="Lisa Satterfield"
        onSignOut={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    await flush();

    // Not shown until expanded.
    expect(screen.queryByText('"Wealth is for building, not hoarding."')).toBeNull();

    fireEvent.click(screen.getByText('What wealth is ultimately for'));
    await flush();

    expect(screen.getByText('"Wealth is for building, not hoarding."')).toBeTruthy();
  });

  it('expanding a theme with no tagged content shows a graceful empty state', async () => {
    vi.spyOn(client, 'getTopics').mockResolvedValue(THEMES);

    render(
      <ExploreByTopic
        clientId="client-1"
        clientName="Lisa Satterfield"
        onSignOut={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    await flush();

    fireEvent.click(screen.getByText('Forgiveness and repairing family rifts'));
    await flush();

    expect(screen.getByText('No answers on this topic yet.')).toBeTruthy();
  });

  it('shows an error message instead of a blank page when the request fails', async () => {
    vi.spyOn(client, 'getTopics').mockRejectedValue(new Error('network error'));

    render(
      <ExploreByTopic
        clientId="client-1"
        clientName="Lisa Satterfield"
        onSignOut={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    await flush();

    expect(screen.getByText(/Something went wrong loading topics/)).toBeTruthy();
  });

  it('the nav toggle calls onNavigate with the other view', async () => {
    vi.spyOn(client, 'getTopics').mockResolvedValue(THEMES);
    const onNavigate = vi.fn();

    render(
      <ExploreByTopic
        clientId="client-1"
        clientName="Lisa Satterfield"
        onSignOut={vi.fn()}
        onNavigate={onNavigate}
      />,
    );
    await flush();

    fireEvent.click(screen.getByText('Ask a Question'));
    expect(onNavigate).toHaveBeenCalledWith('ask');
  });
});
