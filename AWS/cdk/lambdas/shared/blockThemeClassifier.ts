// Block-level theme classification — bridges shared/clipBoundaries.ts's subject-
// block detection to shared/themeClassifier.ts's Claude classification.
//
// Why: a chunk is a silence/speaker-turn unit, not a topic unit — an interviewer
// question can split two unrelated subject answers into the same chunk (e.g. an
// education-funding answer followed by an unrelated debt-repayment answer).
// Classifying the whole chunk's text in one call still finds both themes, but
// leaves no record of *which* block each theme actually came from — so a later
// consumer with no question to disambiguate (the "Explore by Topic" browse view)
// has no way to show the right clip per theme, only a guess (today: whichever
// block is longest). Classifying each block's text independently instead means
// each theme keeps a precise pointer to its own clip.
//
// Chunks with only one subject block (the overwhelming majority — see the
// backfill-theme-tags.ts dry-run: 23 of 27 real chunks) have nothing to
// disambiguate, so this is exactly today's one-call whole-chunk classification
// for them — zero behavior change, zero extra Claude cost.

import { findSubjectBlocks, type SubjectBlock } from './clipBoundaries';
import { classifyChunkThemes } from './themeClassifier';

export interface BlockThemes {
  startTime: number;
  endTime: number;
  text: string;
  themes: string[];
}

export interface ChunkThemeResult {
  themes: string[];                    // chunk-level union of every block's themes (or the
                                        // single whole-chunk result) — this is the field
                                        // query/index.ts's Stage 2 Pinecone filter and
                                        // topics/index.ts's per-chunk grouping already read,
                                        // so neither needs to change to stay correct.
  blockThemes: BlockThemes[] | null;   // null when there was nothing to disambiguate
                                        // (0 or 1 subject block) — nothing new stored.
}

// Called once per is_subject chunk, both at ingestion (process-transcript) and
// by the backfill script. text/sentencesJson/subjectSpeaker mirror exactly what
// classifyChunkThemes and findSubjectBlocks already take elsewhere — no new
// inputs introduced.
export async function classifyChunkOrBlocks(
  chunkText: string,
  sentencesJson: string | undefined,
  subjectSpeaker: string | undefined,
): Promise<ChunkThemeResult> {
  const blocks = findSubjectBlocks(sentencesJson, subjectSpeaker);

  if (blocks.length <= 1) {
    return { themes: await classifyChunkThemes(chunkText), blockThemes: null };
  }

  // Sequential — same rate-limit-conscious style as the existing ingestion loop
  // (one is_subject chunk's worth of blocks at a time, never bursty).
  const blockThemes: BlockThemes[] = [];
  for (const block of blocks) {
    blockThemes.push(await classifyOneBlock(block));
  }

  const themes = [...new Set(blockThemes.flatMap(b => b.themes))];
  return { themes, blockThemes };
}

async function classifyOneBlock(block: SubjectBlock): Promise<BlockThemes> {
  const themes = await classifyChunkThemes(block.text);
  return { startTime: block.startTime, endTime: block.endTime, text: block.text, themes };
}
