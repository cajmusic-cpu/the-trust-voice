import type { ChunkMatch } from './pinecone';

export interface Citation {
  index: number;      // 1-based — matches [N] in the answer text
  videoId: string;
  startTime: number;  // seconds from video start
  endTime: number;
  speaker: string;
  quote: string;      // the transcript text shown as the source excerpt
}

// Converts Pinecone matches to Citation objects, keeping only the chunks that
// Claude actually cited. Preserves the original 1-based index so the frontend
// can render "[1]" as a clickable link to the exact video timestamp.
export function buildCitations(matches: ChunkMatch[], usedIndices: number[]): Citation[] {
  return matches
    .map((m, i) => ({
      index: i + 1,
      videoId: m.metadata.video_id,
      startTime: m.metadata.start_time,
      endTime: m.metadata.end_time,
      speaker: m.metadata.speaker,
      quote: m.metadata.text,
    }))
    .filter(c => usedIndices.includes(c.index));
}
