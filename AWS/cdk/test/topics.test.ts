// lambdas/topics/index.ts — "Explore by Topic" browse view.
//
// groupByTheme is pure (no AWS clients) and covers the core requirement from
// the source doc directly: every theme in the taxonomy appears, in taxonomy
// order, even with zero matching chunks (the graceful "No answers on this
// topic yet" case the frontend renders). The handler test below wires that
// pure function to a mocked DynamoDB + a mocked clipBoundaries to confirm the
// end-to-end route without ever touching real AWS.

const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  QueryCommand: jest.fn((input: unknown) => input),
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));

const mockRefineClipBoundaries = jest.fn();
jest.mock('../lambdas/shared/clipBoundaries', () => ({
  refineClipBoundaries: mockRefineClipBoundaries,
}));

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { groupByTheme, handler, type TopicItem } from '../lambdas/topics/index';
import type { ThemeDef } from '../lambdas/shared/themes';

const THEMES: ThemeDef[] = [
  { key: 'wealth_purpose', section: 'Wealth Philosophy', label: 'What wealth is ultimately for', questionRefs: 'Section 2 Q1' },
  { key: 'family_traditions', section: 'Family', label: 'Family traditions worth preserving', questionRefs: 'Section 3 Q1' },
  { key: 'legacy_intent', section: 'Trustee Decision Principles', label: 'The deeper intent behind the legacy', questionRefs: 'Section 7 Q20', scenarioSpecific: true },
];

function item(overrides: Partial<TopicItem & { themes: string[] }> = {}) {
  return {
    videoId: 'vid-1',
    startTime: 0,
    endTime: 10,
    speaker: 'spk_0',
    quote: 'Some excerpt.',
    themes: ['wealth_purpose'],
    ...overrides,
  };
}

describe('groupByTheme', () => {
  test('every theme in the taxonomy appears, in taxonomy order', () => {
    const groups = groupByTheme(THEMES, []);
    expect(groups.map(g => g.key)).toEqual(['wealth_purpose', 'family_traditions', 'legacy_intent']);
  });

  test('a theme with no matching chunks gets count 0 and an empty items array', () => {
    const groups = groupByTheme(THEMES, []);
    expect(groups[0]).toEqual({
      key: 'wealth_purpose',
      section: 'Wealth Philosophy',
      label: 'What wealth is ultimately for',
      count: 0,
      items: [],
    });
  });

  test('groups a chunk under every theme it is tagged with', () => {
    const chunks = [item({ themes: ['wealth_purpose', 'legacy_intent'] })];
    const groups = groupByTheme(THEMES, chunks);
    expect(groups[0].count).toBe(1);
    expect(groups[1].count).toBe(0);
    expect(groups[2].count).toBe(1);
  });

  test('item shape drops the themes field — only the citation-relevant fields remain', () => {
    const chunks = [item({ videoId: 'vid-9', startTime: 5, endTime: 15, speaker: 'spk_0', quote: 'Quoted.', themes: ['wealth_purpose'] })];
    const groups = groupByTheme(THEMES, chunks);
    expect(groups[0].items).toEqual([
      { videoId: 'vid-9', startTime: 5, endTime: 15, speaker: 'spk_0', quote: 'Quoted.' },
    ]);
  });

  test('multiple chunks under the same theme all appear', () => {
    const chunks = [
      item({ videoId: 'vid-1', themes: ['wealth_purpose'] }),
      item({ videoId: 'vid-2', themes: ['wealth_purpose'] }),
    ];
    const groups = groupByTheme(THEMES, chunks);
    expect(groups[0].count).toBe(2);
    expect(groups[0].items.map(i => i.videoId)).toEqual(['vid-1', 'vid-2']);
  });

  test('an empty taxonomy and empty chunks produce an empty result, not an error', () => {
    expect(groupByTheme([], [])).toEqual([]);
  });
});

// ── Handler wiring ───────────────────────────────────────────────────────

function makeEvent(): APIGatewayProxyEvent {
  return {
    pathParameters: { clientId: 'client-1' },
    requestContext: {
      authorizer: { claims: { 'cognito:groups': 'client-1', email: 'trustee@example.com' } },
    } as unknown as APIGatewayProxyEvent['requestContext'],
    body: null,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEvent;
}

describe('topics handler', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockRefineClipBoundaries.mockReset();
  });

  test('returns the full taxonomy with real chunks grouped under their themes', async () => {
    mockSend.mockResolvedValue({
      Items: [
        {
          video_id: 'vid-1', chunk_index: 0, start_time: 0, end_time: 30,
          speaker: 'spk_0', text: 'Raw text.', sentences_json: '',
          themes: ['wealth_purpose'],
        },
      ],
    });
    // refineClipBoundaries passes metadata through unchanged for this test.
    mockRefineClipBoundaries.mockImplementation((_clientId: string, matches: unknown) => Promise.resolve(matches));

    const res = await handler(makeEvent(), {} as never, () => {}) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { themes: Array<{ key: string; count: number }> };
    const wealth = body.themes.find(t => t.key === 'wealth_purpose');
    expect(wealth?.count).toBe(1);

    // refineClipBoundaries is called with embedding left undefined — no
    // question to score against.
    expect(mockRefineClipBoundaries).toHaveBeenCalledWith('client-1', expect.any(Array), undefined);
  });

  test('a client with no is_subject chunks yet still returns every theme with count 0', async () => {
    mockSend.mockResolvedValue({ Items: [] });
    mockRefineClipBoundaries.mockResolvedValue([]);

    const res = await handler(makeEvent(), {} as never, () => {}) as APIGatewayProxyResult;
    const body = JSON.parse(res.body) as { themes: Array<{ count: number }> };

    expect(body.themes.length).toBeGreaterThan(0);
    expect(body.themes.every(t => t.count === 0)).toBe(true);
  });
});
