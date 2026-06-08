import { parseTranscript } from '../lambdas/process-transcript/parseTranscript';
import { buildChunks, MIN_CHUNK_SECONDS, MAX_CHUNK_SECONDS, INTERJECTION_SECONDS } from '../lambdas/process-transcript/chunk';
import { buildCitations } from '../lambdas/shared/citations';
import type { ChunkMatch } from '../lambdas/shared/pinecone';

// ── parseTranscript ────────────────────────────────────────────────────────

function makeItem(
  content: string,
  type: 'pronunciation' | 'punctuation',
  opts: { start?: string; end?: string; speaker?: string } = {},
) {
  return {
    type,
    alternatives: [{ confidence: '0.99', content }],
    start_time: opts.start,
    end_time: opts.end,
    speaker_label: opts.speaker,
  };
}

describe('parseTranscript', () => {
  test('returns empty array for empty items', () => {
    expect(parseTranscript({ results: { items: [], transcripts: [] } })).toEqual([]);
  });

  test('parses a single pronunciation item', () => {
    const json = {
      results: {
        transcripts: [{ transcript: 'Hello' }],
        items: [makeItem('Hello', 'pronunciation', { start: '0.5', end: '1.0', speaker: 'spk_0' })],
      },
    };
    const words = parseTranscript(json);
    expect(words).toHaveLength(1);
    expect(words[0]).toMatchObject({ text: 'Hello', startTime: 0.5, endTime: 1.0, speaker: 'spk_0' });
  });

  test('fuses punctuation onto the preceding word', () => {
    const json = {
      results: {
        transcripts: [],
        items: [
          makeItem('Hello', 'pronunciation', { start: '0.0', end: '0.5', speaker: 'spk_0' }),
          makeItem(',', 'punctuation'),
          makeItem('world', 'pronunciation', { start: '0.6', end: '1.0', speaker: 'spk_0' }),
          makeItem('.', 'punctuation'),
        ],
      },
    };
    const words = parseTranscript(json);
    expect(words).toHaveLength(2);
    expect(words[0].text).toBe('Hello,');
    expect(words[1].text).toBe('world.');
  });

  test('carries forward speaker label when item has none', () => {
    const json = {
      results: {
        transcripts: [],
        items: [
          makeItem('First', 'pronunciation', { start: '0.0', end: '0.4', speaker: 'spk_0' }),
          makeItem('Second', 'pronunciation', { start: '0.5', end: '0.9' }), // no speaker_label
        ],
      },
    };
    const words = parseTranscript(json);
    expect(words[1].speaker).toBe('spk_0');
  });

  test('ignores items with empty content', () => {
    const json = {
      results: {
        transcripts: [],
        items: [
          { type: 'pronunciation', alternatives: [{ confidence: '0.0', content: '' }] },
          makeItem('Word', 'pronunciation', { start: '0.0', end: '0.3' }),
        ],
      },
    };
    expect(parseTranscript(json)).toHaveLength(1);
  });

  test('handles punctuation at start with no preceding word gracefully', () => {
    const json = {
      results: { transcripts: [], items: [makeItem('.', 'punctuation')] },
    };
    expect(() => parseTranscript(json)).not.toThrow();
    expect(parseTranscript(json)).toHaveLength(0);
  });
});

// ── buildChunks ────────────────────────────────────────────────────────────
//
// Builds words with continuous timestamps across multiple speaker segments.
// Each word is 0.5s apart (0.4s spoken + 0.1s gap).
// Turn duration for a turn of n words = (n-1)*0.5 + 0.4 seconds.
//
// Useful thresholds given the timing constants:
//   MIN_CHUNK_SECONDS (30s) requires >= 62 words in a turn to clear it
//   INTERJECTION_SECONDS (20s) is exceeded by turns of >= 41 words
//   MAX_CHUNK_SECONDS (300s) is exceeded at 601+ words total
function makeWordSeq(...segments: Array<[number, string]>) {
  const words: Array<{ text: string; startTime: number; endTime: number; speaker: string }> = [];
  for (const [count, speaker] of segments) {
    for (let i = 0; i < count; i++) {
      const t = words.length * 0.5;
      words.push({ text: `word${words.length}`, startTime: t, endTime: t + 0.4, speaker });
    }
  }
  return words;
}

describe('buildChunks', () => {
  test('returns empty array for empty input', () => {
    expect(buildChunks([])).toEqual([]);
  });

  test('single speaker produces one chunk with correct timestamps', () => {
    const words = makeWordSeq([10, 'spk_0']);
    const chunks = buildChunks(words);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].text).toBe(words.map(w => w.text).join(' '));
    expect(chunks[0].startTime).toBe(words[0].startTime);
    expect(chunks[0].endTime).toBe(words[9].endTime);
  });

  test('speaker change with long turn splits after MIN_CHUNK_SECONDS', () => {
    // spk_0 for 65 words (~32s > MIN=30s), spk_1 for 45 words (~22s > INTERJECTION=20s)
    // → meets all three split conditions: speaker changed, chunk >= 30s, turn >= 20s
    const words = makeWordSeq([65, 'spk_0'], [45, 'spk_1']);
    const chunks = buildChunks(words);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].speaker).toBe('spk_0');
    expect(chunks[1].speaker).toBe('spk_1');
  });

  test('assigns sequential chunkIndex values', () => {
    const words = makeWordSeq([65, 'spk_0'], [65, 'spk_1']);
    const chunks = buildChunks(words);
    chunks.forEach((c, i) => expect(c.chunkIndex).toBe(i));
  });

  test('brief interjection (< INTERJECTION_SECONDS) stays in same chunk', () => {
    // spk_0 long → spk_1 brief (30 words = 14.9s < INTERJECTION=20s) → spk_0 long
    // The brief spk_1 turn and the spk_0 resumption are both absorbed.
    const words = makeWordSeq([65, 'spk_0'], [30, 'spk_1'], [65, 'spk_0']);
    const chunks = buildChunks(words);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].speaker).toBe('spk_0');
  });

  test('speaker change before MIN_CHUNK_SECONDS does not split', () => {
    // spk_0 for 40 words (~20s < MIN=30s), then spk_1 for 65 words (~32s)
    // spk_1 turn would normally trigger a split but the current chunk is too short
    const words = makeWordSeq([40, 'spk_0'], [65, 'spk_1']);
    const chunks = buildChunks(words);
    expect(chunks).toHaveLength(1);
  });

  test('MAX_CHUNK_SECONDS hard ceiling forces a new chunk', () => {
    // 601 words same speaker (300.4s > MAX=300s), then 10 words different speaker.
    // When the second turn arrives, turn.endTime - chunkStart > 300s → flush first.
    const words = makeWordSeq([601, 'spk_0'], [10, 'spk_1']);
    const chunks = buildChunks(words);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].speaker).toBe('spk_0');
    expect(chunks[0].endTime - chunks[0].startTime).toBeLessThan(MAX_CHUNK_SECONDS + 1);
  });

  test('dominant speaker is the one with most words in the chunk', () => {
    // 5 words spk_0, 10 words spk_1 — both too short to split, spk_1 dominates
    const words = makeWordSeq([5, 'spk_0'], [10, 'spk_1']);
    const chunks = buildChunks(words);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].speaker).toBe('spk_1');
  });

  test('speakerCounts reflects word counts per speaker in chunk', () => {
    const words = makeWordSeq([5, 'spk_0'], [10, 'spk_1']);
    const chunks = buildChunks(words);
    expect(chunks[0].speakerCounts['spk_0']).toBe(5);
    expect(chunks[0].speakerCounts['spk_1']).toBe(10);
  });

  test('unused MIN_CHUNK_SECONDS and INTERJECTION_SECONDS exports are defined', () => {
    expect(typeof MIN_CHUNK_SECONDS).toBe('number');
    expect(typeof INTERJECTION_SECONDS).toBe('number');
  });
});

// ── buildCitations ─────────────────────────────────────────────────────────

function makeMatch(videoId: string, chunkIndex: number, text: string): ChunkMatch {
  return {
    id: `${videoId}/${chunkIndex}`,
    score: 0.9,
    metadata: {
      video_id: videoId,
      chunk_index: chunkIndex,
      start_time: chunkIndex * 60,
      end_time: chunkIndex * 60 + 55,
      speaker: 'spk_0',
      is_subject: true,
      text,
      sentences_json: '[]',
    },
    values: [],
  };
}

describe('buildCitations', () => {
  const matches: ChunkMatch[] = [
    makeMatch('vid-1', 0, 'First excerpt'),
    makeMatch('vid-1', 1, 'Second excerpt'),
    makeMatch('vid-1', 2, 'Third excerpt'),
  ];

  test('returns only citations for indices Claude actually used', () => {
    const citations = buildCitations(matches, [1, 3]);
    expect(citations).toHaveLength(2);
    expect(citations[0].index).toBe(1);
    expect(citations[1].index).toBe(3);
  });

  test('assigns 1-based indices matching the position in matches', () => {
    const citations = buildCitations(matches, [2]);
    expect(citations[0].index).toBe(2);
    expect(citations[0].quote).toBe('Second excerpt');
  });

  test('maps metadata fields correctly', () => {
    const [c] = buildCitations(matches, [1]);
    expect(c.videoId).toBe('vid-1');
    expect(c.startTime).toBe(0);
    expect(c.endTime).toBe(55);
    expect(c.speaker).toBe('spk_0');
  });

  test('returns empty array when no indices match', () => {
    expect(buildCitations(matches, [])).toEqual([]);
    expect(buildCitations(matches, [99])).toEqual([]);
  });

  test('returns empty array for empty matches', () => {
    expect(buildCitations([], [1, 2])).toEqual([]);
  });
});
