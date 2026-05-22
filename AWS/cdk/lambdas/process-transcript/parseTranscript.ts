// Transcribe JSON types — only the fields we use
interface TranscribeItem {
  id?: number;
  type: 'pronunciation' | 'punctuation';
  start_time?: string;
  end_time?: string;
  speaker_label?: string;
  alternatives: Array<{ confidence: string; content: string }>;
}

interface TranscribeResult {
  jobName: string;
  results: {
    transcripts: Array<{ transcript: string }>;
    items: TranscribeItem[];
  };
}

export interface Word {
  text: string;
  startTime: number;  // seconds
  endTime: number;
  speaker: string;    // 'spk_0', 'spk_1', etc. — empty string if no diarization
}

// Converts Transcribe JSON into a flat list of Words.
//
// Punctuation items have no timestamps and are fused onto the preceding word
// (e.g. "Hello," not "Hello ,"). Speaker labels come from the item's
// speaker_label field when ShowSpeakerLabels is enabled.
export function parseTranscript(json: unknown): Word[] {
  const data = json as TranscribeResult;
  const items = data.results?.items ?? [];

  const words: Word[] = [];
  let lastSpeaker = '';

  for (const item of items) {
    const content = item.alternatives[0]?.content ?? '';
    if (!content) continue;

    if (item.type === 'punctuation') {
      // Attach to the preceding word — no space, no timestamp
      if (words.length > 0) {
        words[words.length - 1].text += content;
      }
      continue;
    }

    // pronunciation item
    const speaker = item.speaker_label ?? lastSpeaker;
    if (speaker) lastSpeaker = speaker;

    words.push({
      text: content,
      startTime: parseFloat(item.start_time ?? '0'),
      endTime: parseFloat(item.end_time ?? '0'),
      speaker,
    });
  }

  return words;
}
