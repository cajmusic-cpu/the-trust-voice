import type { Word } from './parseTranscript';

export interface Chunk {
  chunkIndex: number;
  text: string;
  startTime: number;
  endTime: number;
  speaker: string;    // dominant speaker (most words in the chunk)
}

const MAX_WORDS = 200;

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
    const speakerCount: Record<string, number> = {};
    for (const w of slice) {
      speakerCount[w.speaker] = (speakerCount[w.speaker] ?? 0) + 1;
    }
    const speaker = Object.entries(speakerCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

    chunks.push({
      chunkIndex: chunks.length,
      text,
      startTime: slice[0].startTime,
      endTime: slice[slice.length - 1].endTime,
      speaker,
    });

    start = end;
  }

  return chunks;
}
