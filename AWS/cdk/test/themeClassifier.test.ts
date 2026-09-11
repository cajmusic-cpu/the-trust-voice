// themeClassifier — mocked-Claude unit tests.
//
// Verifies the classifier (a) only ever returns keys that exist in the real
// THEMES table, (b) never throws, and (c) short-circuits on empty input
// without spending a Claude call. Real classification quality (does the
// prompt produce *good* tags) was checked separately via the dry-run backfill
// against real interview data (theme-tags-review-2026-09-11.csv) — this suite
// only covers the parsing/validation contract themeClassifier promises its
// callers (ingestion and query/index.ts Stage 2 both depend on it never
// throwing and never inventing a key).

jest.mock('../lambdas/shared/claude', () => ({
  getClient: jest.fn(),
}));

import { getClient } from '../lambdas/shared/claude';
import { classifyChunkThemes, classifyQuestionThemes, THEME_COUNT } from '../lambdas/shared/themeClassifier';
import { THEMES } from '../lambdas/shared/themes';

const mockGetClient = getClient as jest.MockedFunction<typeof getClient>;

function mockCreate(text: string) {
  return jest.fn().mockResolvedValue({ content: [{ type: 'text', text }] });
}

beforeEach(() => {
  mockGetClient.mockReset();
});

describe('THEMES table sanity', () => {
  test('THEME_COUNT reflects the real taxonomy', () => {
    expect(THEME_COUNT).toBe(THEMES.length);
    expect(THEME_COUNT).toBeGreaterThan(0);
  });
});

describe('classifyChunkThemes', () => {
  test('returns a valid key parsed from a bare JSON array', async () => {
    const create = mockCreate('["wealth_purpose"]');
    mockGetClient.mockResolvedValue({ messages: { create } } as never);

    const themes = await classifyChunkThemes('Some transcript text about money.');
    expect(themes).toEqual(['wealth_purpose']);
  });

  test('drops keys that are not in the taxonomy', async () => {
    const create = mockCreate('["wealth_purpose", "not_a_real_theme"]');
    mockGetClient.mockResolvedValue({ messages: { create } } as never);

    const themes = await classifyChunkThemes('text');
    expect(themes).toEqual(['wealth_purpose']);
  });

  test('caps at 2 themes even if Claude returns more', async () => {
    const create = mockCreate('["wealth_purpose", "family_traditions", "forgiveness"]');
    mockGetClient.mockResolvedValue({ messages: { create } } as never);

    const themes = await classifyChunkThemes('text');
    expect(themes).toHaveLength(2);
    expect(themes).toEqual(['wealth_purpose', 'family_traditions']);
  });

  test('deduplicates repeated keys', async () => {
    const create = mockCreate('["wealth_purpose", "wealth_purpose"]');
    mockGetClient.mockResolvedValue({ messages: { create } } as never);

    const themes = await classifyChunkThemes('text');
    expect(themes).toEqual(['wealth_purpose']);
  });

  test('tolerates a response wrapped in prose or a code fence', async () => {
    const create = mockCreate('Sure, here you go:\n```json\n["forgiveness"]\n```\nHope that helps!');
    mockGetClient.mockResolvedValue({ messages: { create } } as never);

    const themes = await classifyChunkThemes('text');
    expect(themes).toEqual(['forgiveness']);
  });

  test('returns [] on an explicit empty array (no confident match)', async () => {
    const create = mockCreate('[]');
    mockGetClient.mockResolvedValue({ messages: { create } } as never);

    expect(await classifyChunkThemes('text')).toEqual([]);
  });

  test('returns [] on malformed JSON without throwing', async () => {
    const create = mockCreate('not json at all');
    mockGetClient.mockResolvedValue({ messages: { create } } as never);

    await expect(classifyChunkThemes('text')).resolves.toEqual([]);
  });

  test('returns [] and never calls Claude for blank/whitespace-only text', async () => {
    const create = mockCreate('["wealth_purpose"]');
    mockGetClient.mockResolvedValue({ messages: { create } } as never);

    expect(await classifyChunkThemes('   ')).toEqual([]);
    expect(mockGetClient).not.toHaveBeenCalled();
  });

  test('returns [] instead of throwing when the Claude call itself fails', async () => {
    mockGetClient.mockRejectedValue(new Error('secret fetch failed'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(classifyChunkThemes('text')).resolves.toEqual([]);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('classifyQuestionThemes', () => {
  test('uses the same validation contract as classifyChunkThemes', async () => {
    const create = mockCreate('["helping_vs_enabling", "bogus_key"]');
    mockGetClient.mockResolvedValue({ messages: { create } } as never);

    const themes = await classifyQuestionThemes('Should the trust support someone who could work but doesn\'t?');
    expect(themes).toEqual(['helping_vs_enabling']);
  });
});
