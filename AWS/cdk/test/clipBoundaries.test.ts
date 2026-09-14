// shared/clipBoundaries.ts — relocated verbatim out of query/index.ts (see
// query-principle-bridge.test.ts for the regression proof that the move
// didn't change query/index.ts's behavior). No dedicated tests existed for
// this logic before the move; these cover it directly now that it's an
// independently importable module (also used by lambdas/topics/index.ts,
// always with embedding left undefined).

const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  GetCommand: jest.fn((input: unknown) => input),
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));

const mockEmbedTexts = jest.fn();
jest.mock('../lambdas/shared/embed', () => ({ embedTexts: mockEmbedTexts }));

import {
  cosineSimilarity,
  speakerBoundaries,
  fetchSubjectSpeaker,
  refineClipBoundaries,
  findSubjectBlocks,
  type SentenceMarker,
} from '../lambdas/shared/clipBoundaries';
import type { ChunkMatch } from '../lambdas/shared/pinecone';

beforeEach(() => {
  mockSend.mockReset();
  mockEmbedTexts.mockReset();
});

// ── cosineSimilarity ─────────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  test('identical vectors score 1', () => {
    expect(cosineSimilarity([1, 0, 1], [1, 0, 1])).toBeCloseTo(1);
  });

  test('orthogonal vectors score 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  test('a zero-length vector returns 0 rather than NaN', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

// ── findSubjectBlocks ────────────────────────────────────────────────────

function sentence(overrides: Partial<SentenceMarker>): SentenceMarker {
  return { startTime: 0, endTime: 0, text: '', speaker: 'spk_0', ...overrides };
}

describe('findSubjectBlocks', () => {
  test('returns [] when sentencesJson is absent', () => {
    expect(findSubjectBlocks(undefined)).toEqual([]);
  });

  test('returns [] on malformed JSON', () => {
    expect(findSubjectBlocks('not json')).toEqual([]);
  });

  test('returns [] for an empty sentences array', () => {
    expect(findSubjectBlocks('[]')).toEqual([]);
  });

  test('returns [] when sentences lack speaker labels', () => {
    const sentences = [{ startTime: 0, endTime: 1, text: 'hi' }];
    expect(findSubjectBlocks(JSON.stringify(sentences))).toEqual([]);
  });

  test('one uninterrupted subject turn yields exactly one block spanning it', () => {
    const sentences: SentenceMarker[] = [
      sentence({ startTime: 0, endTime: 2, text: 'One.', speaker: 'spk_0' }),
      sentence({ startTime: 2.2, endTime: 4, text: 'Two.', speaker: 'spk_0' }),
    ];
    const blocks = findSubjectBlocks(JSON.stringify(sentences));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ startIdx: 0, endIdx: 2, startTime: 0, endTime: 4, text: 'One. Two.' });
  });

  test('an interviewer question splitting two subject answers yields two blocks, each with its own boundaries', () => {
    // Mirrors the real Lisa Satterfield chunk 7 shape that surfaced this bug:
    // subject answer, interviewer question, unrelated subject answer.
    const sentences: SentenceMarker[] = [
      sentence({ startTime: 0, endTime: 5, text: 'Answer about education.', speaker: 'spk_1' }),
      sentence({ startTime: 12, endTime: 14, text: 'What about debt?', speaker: 'spk_0' }),
      sentence({ startTime: 20, endTime: 25, text: 'Answer about debt.', speaker: 'spk_1' }),
    ];
    const blocks = findSubjectBlocks(JSON.stringify(sentences), 'spk_1');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ startTime: 0, endTime: 5, text: 'Answer about education.' });
    expect(blocks[1]).toMatchObject({ startTime: 20, endTime: 25, text: 'Answer about debt.' });
  });

  test('a brief interjection (< silence gap) does not split the block', () => {
    const sentences: SentenceMarker[] = [
      sentence({ startTime: 0, endTime: 2, text: 'Part one.', speaker: 'spk_1' }),
      sentence({ startTime: 2.3, endTime: 2.6, text: 'mm-hm', speaker: 'spk_0' }),
      sentence({ startTime: 2.8, endTime: 5, text: 'Part two.', speaker: 'spk_1' }),
    ];
    const blocks = findSubjectBlocks(JSON.stringify(sentences), 'spk_1');
    expect(blocks).toHaveLength(1);
  });

  test('an explicit subjectSpeaker overrides the local sentence-count majority', () => {
    const sentences: SentenceMarker[] = [
      sentence({ startTime: 0, endTime: 1, text: 'spk_0 line.', speaker: 'spk_0' }),
      sentence({ startTime: 5, endTime: 6, text: 'spk_1 line one.', speaker: 'spk_1' }),
      sentence({ startTime: 6.2, endTime: 7, text: 'spk_1 line two.', speaker: 'spk_1' }),
    ];
    const blocks = findSubjectBlocks(JSON.stringify(sentences), 'spk_0');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('spk_0 line.');
  });
});

// ── speakerBoundaries ────────────────────────────────────────────────────

describe('speakerBoundaries', () => {
  const fallbackArgs = [0, 30, 'full chunk text'] as const;

  test('returns original boundaries when sentencesJson is absent', async () => {
    const result = await speakerBoundaries(undefined, ...fallbackArgs);
    expect(result).toEqual({ startTime: 0, endTime: 30, text: 'full chunk text' });
  });

  test('returns original boundaries on malformed JSON', async () => {
    const result = await speakerBoundaries('not json', ...fallbackArgs);
    expect(result).toEqual({ startTime: 0, endTime: 30, text: 'full chunk text' });
  });

  test('returns original boundaries when sentences array is empty', async () => {
    const result = await speakerBoundaries('[]', ...fallbackArgs);
    expect(result).toEqual({ startTime: 0, endTime: 30, text: 'full chunk text' });
  });

  test('trims to the subject block on a silence gap, dropping the interviewer tail', async () => {
    const sentences: SentenceMarker[] = [
      sentence({ startTime: 0, endTime: 2, text: 'Subject sentence one.', speaker: 'spk_0' }),
      sentence({ startTime: 2.2, endTime: 4, text: 'Subject sentence two.', speaker: 'spk_0' }),
      // >= 2.5s gap here closes the block
      sentence({ startTime: 8, endTime: 9, text: 'Interviewer follow-up.', speaker: 'spk_1' }),
    ];
    const result = await speakerBoundaries(JSON.stringify(sentences), 0, 30, 'ignored');
    expect(result.startTime).toBe(0);
    expect(result.endTime).toBe(4);
    expect(result.text).toBe('Subject sentence one. Subject sentence two.');
  });

  test('with no queryEmbedding, picks the largest of multiple subject blocks', async () => {
    const sentences: SentenceMarker[] = [
      sentence({ startTime: 0, endTime: 1, text: 'Short block.', speaker: 'spk_0' }),
      sentence({ startTime: 5, endTime: 6, text: 'Interviewer.', speaker: 'spk_1' }),
      sentence({ startTime: 10, endTime: 11, text: 'Long block sentence one.', speaker: 'spk_0' }),
      sentence({ startTime: 11.2, endTime: 12, text: 'Long block sentence two.', speaker: 'spk_0' }),
      sentence({ startTime: 12.2, endTime: 13, text: 'Long block sentence three.', speaker: 'spk_0' }),
    ];
    const result = await speakerBoundaries(JSON.stringify(sentences), 0, 30, 'ignored');
    expect(result.text).toBe('Long block sentence one. Long block sentence two. Long block sentence three.');
    expect(mockEmbedTexts).not.toHaveBeenCalled();
  });

  test('with a queryEmbedding and multiple blocks, picks the block closest to the query', async () => {
    const sentences: SentenceMarker[] = [
      sentence({ startTime: 0, endTime: 1, text: 'Block A.', speaker: 'spk_0' }),
      sentence({ startTime: 5, endTime: 6, text: 'Interviewer.', speaker: 'spk_1' }),
      sentence({ startTime: 10, endTime: 11, text: 'Block B.', speaker: 'spk_0' }),
    ];
    // Block A embeds as [1,0] (orthogonal to the query), Block B as [0,1] (parallel).
    mockEmbedTexts.mockResolvedValue([[1, 0], [0, 1]]);
    const result = await speakerBoundaries(JSON.stringify(sentences), 0, 30, 'ignored', [0, 1]);
    expect(result.text).toBe('Block B.');
    expect(mockEmbedTexts).toHaveBeenCalledWith(['Block A.', 'Block B.']);
  });

  test('an explicit subjectSpeaker overrides the local sentence-count majority', async () => {
    // spk_1 has more sentences, but subjectSpeaker says spk_0 is the subject.
    const sentences: SentenceMarker[] = [
      sentence({ startTime: 0, endTime: 1, text: 'spk_0 line.', speaker: 'spk_0' }),
      sentence({ startTime: 5, endTime: 6, text: 'spk_1 line one.', speaker: 'spk_1' }),
      sentence({ startTime: 6.2, endTime: 7, text: 'spk_1 line two.', speaker: 'spk_1' }),
    ];
    const result = await speakerBoundaries(JSON.stringify(sentences), 0, 30, 'ignored', undefined, 'spk_0');
    expect(result.text).toBe('spk_0 line.');
  });
});

// ── fetchSubjectSpeaker ──────────────────────────────────────────────────

describe('fetchSubjectSpeaker', () => {
  test('returns the stored subject_speaker', async () => {
    mockSend.mockResolvedValue({ Item: { subject_speaker: 'spk_0' } });
    expect(await fetchSubjectSpeaker('client-1', 'video-1')).toBe('spk_0');
  });

  test('returns undefined when the video record has none', async () => {
    mockSend.mockResolvedValue({ Item: {} });
    expect(await fetchSubjectSpeaker('client-1', 'video-1')).toBeUndefined();
  });

  test('returns undefined when the video record does not exist', async () => {
    mockSend.mockResolvedValue({});
    expect(await fetchSubjectSpeaker('client-1', 'video-1')).toBeUndefined();
  });
});

// ── refineClipBoundaries ─────────────────────────────────────────────────

function makeMatch(overrides: Partial<ChunkMatch['metadata']> = {}): ChunkMatch {
  return {
    id: 'vid-1/0',
    score: 0,
    values: [],
    metadata: {
      video_id: 'vid-1',
      chunk_index: 0,
      start_time: 0,
      end_time: 30,
      speaker: 'spk_0',
      is_subject: true,
      text: 'full chunk text',
      sentences_json: '',
      themes: [],
      block_themes_json: '',
      ...overrides,
    },
  };
}

describe('refineClipBoundaries', () => {
  test('trims each match using its own sentences_json and the video subject speaker', async () => {
    mockSend.mockResolvedValue({ Item: { subject_speaker: 'spk_0' } });
    const sentences: SentenceMarker[] = [
      sentence({ startTime: 0, endTime: 2, text: 'Kept.', speaker: 'spk_0' }),
      sentence({ startTime: 8, endTime: 9, text: 'Dropped.', speaker: 'spk_1' }),
    ];
    const match = makeMatch({ sentences_json: JSON.stringify(sentences) });

    const [refined] = await refineClipBoundaries('client-1', [match], undefined);

    expect(refined.metadata.text).toBe('Kept.');
    expect(refined.metadata.end_time).toBe(2);
    // Fields untouched by trimming are preserved as-is.
    expect(refined.metadata.video_id).toBe('vid-1');
    expect(refined.id).toBe('vid-1/0');
  });

  test('falls back to original boundaries for a chunk with no sentences_json', async () => {
    mockSend.mockResolvedValue({ Item: {} });
    const match = makeMatch({ sentences_json: '' });

    const [refined] = await refineClipBoundaries('client-1', [match], undefined);

    expect(refined.metadata.text).toBe('full chunk text');
    expect(refined.metadata.start_time).toBe(0);
    expect(refined.metadata.end_time).toBe(30);
  });

  test('looks up the subject speaker once per distinct video, not once per match', async () => {
    mockSend.mockResolvedValue({ Item: { subject_speaker: 'spk_0' } });
    const a = makeMatch({ id: 'vid-1/0' });
    const b = makeMatch({ id: 'vid-1/1', chunk_index: 1 });

    await refineClipBoundaries('client-1', [a, b], undefined);

    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
