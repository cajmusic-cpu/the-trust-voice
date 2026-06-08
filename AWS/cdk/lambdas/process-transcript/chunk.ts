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
  speaker: string;
  speakerCounts: Record<string, number>;  // word count per speaker label
  sentences: Sentence[];
}

// A chunk must reach this duration before a speaker change can trigger a split.
export const MIN_CHUNK_SECONDS = 30;

// Hard ceiling — no chunk will ever exceed this, even if one speaker holds
// the floor continuously. Prevents runaway chunks on long monologues.
export const MAX_CHUNK_SECONDS = 300;

// A new-speaker turn shorter than this is treated as a brief interjection
// (an "uh-huh", a short follow-up, a clarifying question) and is absorbed
// into the current chunk rather than starting a new one.
export const INTERJECTION_SECONDS = 20;

// A consecutive run of words from the same speaker.
interface SpeakerTurn {
  speaker: string;
  words: Word[];
  startTime: number;
  endTime: number;
  duration: number;   // endTime - startTime (seconds)
}

// Groups consecutive same-speaker words into turns.
function buildSpeakerTurns(words: Word[]): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  let i = 0;
  while (i < words.length) {
    const speaker = words[i].speaker;
    const start = i;
    while (i < words.length && words[i].speaker === speaker) i++;
    const slice = words.slice(start, i);
    turns.push({
      speaker,
      words: slice,
      startTime: slice[0].startTime,
      endTime: slice[slice.length - 1].endTime,
      duration: slice[slice.length - 1].endTime - slice[0].startTime,
    });
  }
  return turns;
}

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

// Splits a transcript word list into Chunks based on speaker turns.
//
// Chunking rules (all conditions must hold to start a new chunk):
//   1. The incoming turn's speaker differs from the current chunk's dominant speaker
//   2. The current chunk has already reached MIN_CHUNK_SECONDS
//   3. The incoming turn is at least INTERJECTION_SECONDS long
//      (shorter turns are treated as brief interjections and absorbed)
//
// MAX_CHUNK_SECONDS is a hard ceiling: if adding a turn would push the chunk
// past that limit, the current chunk is flushed first regardless of the above.
//
// Timestamps come directly from the Transcribe word-level output — startTime
// is the first word's start, endTime is the last word's end.
export function buildChunks(words: Word[]): Chunk[] {
  if (words.length === 0) return [];

  const turns = buildSpeakerTurns(words);
  const chunks: Chunk[] = [];
  let pending: SpeakerTurn[] = [];

  function flush(): void {
    if (pending.length === 0) return;
    const allWords = pending.flatMap(t => t.words);
    const speakerCounts: Record<string, number> = {};
    for (const t of pending) {
      speakerCounts[t.speaker] = (speakerCounts[t.speaker] ?? 0) + t.words.length;
    }
    const speaker = Object.entries(speakerCounts)
      .sort((a, b) => b[1] - a[1])[0]![0];
    chunks.push({
      chunkIndex: chunks.length,
      text: allWords.map(w => w.text).join(' '),
      startTime: pending[0].startTime,
      endTime: pending[pending.length - 1].endTime,
      speaker,
      speakerCounts,
      sentences: buildSentences(allWords),
    });
    pending = [];
  }

  for (const turn of turns) {
    if (pending.length === 0) {
      pending.push(turn);
      continue;
    }

    const chunkStart = pending[0].startTime;

    // Hard ceiling: flush and start fresh before this turn would push us over max.
    if (turn.endTime - chunkStart >= MAX_CHUNK_SECONDS) {
      flush();
      pending.push(turn);
      continue;
    }

    // Dominant speaker = whoever has accumulated the most time in the current chunk.
    const spkSeconds: Record<string, number> = {};
    for (const t of pending) {
      spkSeconds[t.speaker] = (spkSeconds[t.speaker] ?? 0) + t.duration;
    }
    const dominant = Object.entries(spkSeconds)
      .sort((a, b) => b[1] - a[1])[0]![0];

    if (turn.speaker === dominant || turn.duration < INTERJECTION_SECONDS) {
      // Dominant speaker resumes (possibly after an interjection), or the
      // incoming turn is a brief interjection — keep it in the current chunk.
      pending.push(turn);
      continue;
    }

    // Non-dominant speaker is starting a substantial turn.
    // Only split if the current chunk has reached the minimum duration.
    const currentDuration = pending[pending.length - 1].endTime - chunkStart;
    if (currentDuration >= MIN_CHUNK_SECONDS) {
      flush();
    }
    pending.push(turn);
  }

  flush();
  return chunks;
}
