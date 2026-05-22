// Run with: node generate-test-transcript.mjs
// Generates a synthetic Amazon Transcribe JSON for the test estate interview.

const VIDEO_ID = '1430b5f4-a286-4426-86f8-be79c7c7b149';

const sentences = [
  { speaker: 'spk_0', text: 'My name is Robert Allen.', start: 0.5 },
  { speaker: 'spk_0', text: 'I am recording this video to make my wishes clear to my family and trustees.', start: 2.5 },
  { speaker: 'spk_0', text: 'Regarding the lake house in Vermont, I want it to remain in the family.', start: 7.2 },
  { speaker: 'spk_0', text: 'It should not be sold.', start: 12.0 },
  { speaker: 'spk_0', text: 'My daughter Claire and my son David should share equal access and equal responsibility for its upkeep.', start: 14.5 },
  { speaker: 'spk_0', text: 'If they cannot agree, I would like the property placed in a trust managed by my attorney.', start: 21.0 },
  { speaker: 'spk_0', text: 'Regarding my investment portfolio, I want the accounts split equally three ways between Claire, David, and my youngest, Thomas.', start: 28.0 },
  { speaker: 'spk_0', text: 'Thomas is still young, so his share should be held in trust until he turns thirty.', start: 37.0 },
  { speaker: 'spk_0', text: 'The charitable foundation is very important to me.', start: 44.5 },
  { speaker: 'spk_0', text: 'I want ten percent of the estate to go to the foundation each year for five years.', start: 48.0 },
  { speaker: 'spk_0', text: 'My wife Margaret should receive the house in Boston and all personal property.', start: 55.0 },
  { speaker: 'spk_0', text: 'Her comfort and security comes first.', start: 62.0 },
  { speaker: 'spk_0', text: 'Everything else should follow the instructions in the written will.', start: 66.0 },
  { speaker: 'spk_0', text: 'I trust my family to honor these wishes.', start: 71.5 },
];

const WORDS_PER_SECOND = 2.5;

function buildItems(sentences) {
  const items = [];
  let id = 0;

  for (const sentence of sentences) {
    const tokens = sentence.text.split(/\s+/);
    let t = sentence.start;

    for (const token of tokens) {
      // Separate trailing punctuation from the word
      const match = token.match(/^([a-zA-Z0-9''-]+)([.,!?;]?)$/);
      const word = match ? match[1] : token;
      const punct = match ? match[2] : '';

      const duration = 0.3 + word.length * 0.04;
      items.push({
        id: id++,
        type: 'pronunciation',
        start_time: t.toFixed(2),
        end_time: (t + duration).toFixed(2),
        speaker_label: sentence.speaker,
        alternatives: [{ confidence: '0.99', content: word }],
      });

      if (punct) {
        items.push({
          type: 'punctuation',
          alternatives: [{ confidence: '0.0', content: punct }],
        });
      }

      t += duration + 0.05;
    }
  }

  return items;
}

const items = buildItems(sentences);
const fullText = sentences.map(s => s.text).join(' ');

// Build speaker_labels.segments
const lastItem = items.filter(i => i.type === 'pronunciation').at(-1);
const segments = [{
  start_time: '0.50',
  end_time: lastItem.end_time,
  speaker_label: 'spk_0',
  items: items.filter(i => i.type === 'pronunciation'),
}];

const transcript = {
  jobName: `ttv-${VIDEO_ID}`,
  accountId: '595028889888',
  results: {
    transcripts: [{ transcript: fullText }],
    speaker_labels: { speakers: 1, segments },
    items,
  },
  status: 'COMPLETED',
};

import { writeFileSync } from 'fs';
const filename = `test-transcript-${VIDEO_ID}.json`;
writeFileSync(filename, JSON.stringify(transcript, null, 2));
console.log(`Written: ${filename}`);
console.log(`Words: ${items.filter(i => i.type === 'pronunciation').length}`);
