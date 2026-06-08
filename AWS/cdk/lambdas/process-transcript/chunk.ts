import type { Word } from './parseTranscript';

export interface Sentence {
  startTime: number;
  text: string;
}

export interface Chunk {
  chunkIndex: number;
  text: string;
  startTime: number;
  endTime: number;
  speaker: string;    // dominant speaker (most words in the chunk)
  speakerCounts: Record<string, number>;  // word count per speaker label
  sentences: Sentence[];
}

// ~70s at conversational pace (~130 wpm); large enough to cover a full Q&A answer.
const MAX_WORDS = 150;

// Groups words into sentences by terminal punctuation (.?!).
// Requires at least 5 words before cutting to avoid splitting on abbreviations.
function buildSentences(words: Word[]): Sentence[] {
  const sentences: Sentence[] = [];
  let buf: Word[] = [];

  for (const word of words) {
    buf.push(word);
    if (buf.length >= 5 && /[.?!]$/.test(word.text)) {
      sentences.push({ startTime: buf[0].startTime, text: buf.map(w => w.text).join(' ') });
      buf = [];
    }
  }

  if (buf.length > 0) {
    sentences.push({ startTime: buf[0].startTime, text: buf.map(w => w.text).join(' ') });
  }

  return sentences;
}

// Splits a word list into Chunks of at most MAX_WORDS words.
//
// Speaker-boundary cuts: if the speaker changes and we're already past the
// halfway point of a chunk, we cut early. This keeps excerpts to a single
// voice where possible, producing cleaner citation quotes.
export function buildChunks(words: Word[]): Chunk[] {
  if (words.length === 0) return [];

  const chunks: Chunk[] = [];
  let start = 0;

  while (start < words.length) {
    let end = Math.min(start + MAX_WORDS, words.length);

    // Look for a speaker change after the halfway mark and cut there
    if (end < words.length) {
      const halfway = start + Math.floor(MAX_WORDS / 2);
      for (let i = halfway; i < end; i++) {
        if (words[i].speaker !== words[start].speaker) {
          end = i;
          break;
        }
      }
    }

    const slice = words.slice(start, end);
    const text = slice.map(w => w.text).join(' ');

    // Dominant speaker = whichever speaker contributed the most words
    const speakerCounts: Record<string, number> = {};
    for (const w of slice) {
      speakerCounts[w.speaker] = (speakerCounts[w.speaker] ?? 0) + 1;
    }
    const speaker = Object.entries(speakerCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

    chunks.push({
      chunkIndex: chunks.length,
      text,
      startTime: slice[0].startTime,
      endTime: slice[slice.length - 1].endTime,
      speaker,
      speakerCounts,
      sentences: buildSentences(slice),
    });

    start = end;
  }

  return chunks;
}
