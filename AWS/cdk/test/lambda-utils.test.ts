import { parseTranscript } from '../lambdas/process-transcript/parseTranscript';
import { buildChunks } from '../lambdas/process-transcript/chunk';
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

function makeWords(count: number, speaker = 'spk_0') {
  return Array.from({ length: count }, (_, i) => ({
    text: `word${i}`,
    startTime: i * 0.5,
    endTime: i * 0.5 + 0.4,
    speaker,
  }));
}

describe('buildChunks', () => {
  test('returns empty array for empty input', () => {
    expect(buildChunks([])).toEqual([]);
  });

  test('single chunk when word count is below MAX_WORDS', () => {
    const words = makeWords(10);
    const chunks = buildChunks(words);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].text).toBe(words.map(w => w.text).join(' '));
    expect(chunks[0].startTime).toBe(words[0].startTime);
    expect(chunks[0].endTime).toBe(words[9].endTime);
  });

  test('splits into multiple chunks when word count exceeds MAX_WORDS (80)', () => {
    const words = makeWords(90);
    const chunks = buildChunks(words);
    expect(chunks.length).toBeGreaterThan(1);
    const totalWords = chunks.reduce((sum, c) => sum + c.text.split(' ').length, 0);
    expect(totalWords).toBe(90);
  });

  test('assigns sequential chunkIndex values', () => {
    const chunks = buildChunks(makeWords(250));
    chunks.forEach((c, i) => expect(c.chunkIndex).toBe(i));
  });

  test('cuts early at speaker boundary after halfway mark', () => {
    // MAX_WORDS=80, halfway=40. Need total > 80 so end < words.length fires.
    // spk_0: words 0-49 (50 words), spk_1: words 50-99 (50 words).
    // halfway=40; loop finds speaker change at index 50 → chunk ends at 50.
    const words = [
      ...makeWords(50, 'spk_0'),
      ...makeWords(50, 'spk_1'),
    ];
    const chunks = buildChunks(words);
    expect(chunks[0].text.split(' ')).toHaveLength(50);
    expect(chunks[0].speaker).toBe('spk_0');
    expect(chunks[1].speaker).toBe('spk_1');
  });

  test('dominant speaker is the one with most words in chunk', () => {
    const words = [
      ...makeWords(3, 'spk_0'),
      ...makeWords(7, 'spk_1'), // spk_1 is dominant
    ];
    const chunks = buildChunks(words);
    expect(chunks[0].speaker).toBe('spk_1');
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
