import type { Word } from './parseTranscript';

export interface Sentence {
  startTime: number;
  text: string;
  speaker: string;  // speaker label of the first word in the sentence ('spk_0', 'spk_1', etc.)
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

// A chunk must reach this duration before a substantial non-dominant turn
// can trigger a split. Kept low (15s) so that an interviewer question of
// 15–20 s forms its own chunk rather than being prepended to the subject's
// next answer. Does not apply when TOPIC_BREAK_SECONDS has been reached.
export const MIN_CHUNK_SECONDS = 15;

// Hard ceiling — no chunk will ever exceed this, even if one speaker holds
// the floor continuously. Prevents runaway chunks on long monologues.
export const MAX_CHUNK_SECONDS = 300;

// A new-speaker turn shorter than this is treated as a brief interjection
// (an "uh-huh", a short follow-up) and is absorbed into the current chunk.
// Does NOT apply once the chunk has reached TOPIC_BREAK_SECONDS.
// Kept at 10 s — 20 s caused multi-question interviewer turns (~15 s) to be
// absorbed into the preceding subject chunk, creating multi-topic chunks that
// misled speakerBoundaries into clipping wrong content.
export const INTERJECTION_SECONDS = 10;

// Once the dominant speaker has held the floor for this long, any speaker
// change — even a brief one below INTERJECTION_SECONDS — forces an
// immediate chunk boundary. Prevents an interviewer's next question (often
// 8–15 s) from being absorbed into the tail of a long subject answer.
export const TOPIC_BREAK_SECONDS = 60;

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
      sentences.push({ startTime: buf[0].startTime, text: buf.map(w => w.text).join(' '), speaker: buf[0].speaker });
      buf = [];
    }
  }

  if (buf.length > 0) {
    sentences.push({ startTime: buf[0].startTime, text: buf.map(w => w.text).join(' '), speaker: buf[0].speaker });
  }

  return sentences;
}

// Splits a transcript word list into Chunks based on speaker turns.
//
// Split conditions for a non-dominant speaker turn:
//   • TOPIC_BREAK_SECONDS reached — flush immediately regardless of turn length
//   • turn >= INTERJECTION_SECONDS AND chunk >= MIN_CHUNK_SECONDS — standard split
//   • turn < INTERJECTION_SECONDS AND chunk < TOPIC_BREAK_SECONDS — absorb (interjection)
//
// MAX_CHUNK_SECONDS is a hard ceiling flushed before applying any other rule.
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
    const currentDuration = pending[pending.length - 1].endTime - chunkStart;

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

    if (turn.speaker === dominant) {
      // Dominant speaker resumes (possibly after an absorbed interjection).
      pending.push(turn);
      continue;
    }

    // Topic boundary: once the dominant speaker has held the floor for
    // TOPIC_BREAK_SECONDS, any speaker change — even a brief question
    // that would otherwise be absorbed — forces a chunk boundary.
    if (currentDuration >= TOPIC_BREAK_SECONDS) {
      flush();
      pending.push(turn);
      continue;
    }

    // Brief interjection on a shorter chunk: absorb it.
    if (turn.duration < INTERJECTION_SECONDS) {
      pending.push(turn);
      continue;
    }

    // Substantial non-dominant turn: flush if minimum duration reached.
    if (currentDuration >= MIN_CHUNK_SECONDS) {
      flush();
    }
    pending.push(turn);
  }

  flush();
  return chunks;
}
