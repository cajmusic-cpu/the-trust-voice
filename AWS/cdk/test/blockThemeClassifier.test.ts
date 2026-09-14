// shared/blockThemeClassifier.ts — mocked-classifyChunkThemes unit tests.
//
// Confirms the two paths: a chunk with 0/1 subject block classifies its whole
// text exactly once and stores no block_themes (today's exact behavior,
// unchanged), while a chunk with >1 block classifies each block independently
// and unions their themes for the chunk-level field.

const mockClassifyChunkThemes = jest.fn();
jest.mock('../lambdas/shared/themeClassifier', () => ({
  classifyChunkThemes: mockClassifyChunkThemes,
}));

import { classifyChunkOrBlocks } from '../lambdas/shared/blockThemeClassifier';
import type { SentenceMarker } from '../lambdas/shared/clipBoundaries';

function sentence(overrides: Partial<SentenceMarker>): SentenceMarker {
  return { startTime: 0, endTime: 0, text: '', speaker: 'spk_0', ...overrides };
}

beforeEach(() => {
  mockClassifyChunkThemes.mockReset();
});

describe('classifyChunkOrBlocks — single/no-block chunks (the common case)', () => {
  test('no sentencesJson: classifies the whole chunk text once, blockThemes is null', async () => {
    mockClassifyChunkThemes.mockResolvedValue(['wealth_purpose']);

    const result = await classifyChunkOrBlocks('Whole chunk text.', undefined, undefined);

    expect(result).toEqual({ themes: ['wealth_purpose'], blockThemes: null });
    expect(mockClassifyChunkThemes).toHaveBeenCalledTimes(1);
    expect(mockClassifyChunkThemes).toHaveBeenCalledWith('Whole chunk text.');
  });

  test('exactly one subject block: still one whole-chunk call, blockThemes is null', async () => {
    mockClassifyChunkThemes.mockResolvedValue(['financial_habits']);
    const sentences: SentenceMarker[] = [
      sentence({ startTime: 0, endTime: 2, text: 'One.', speaker: 'spk_1' }),
      sentence({ startTime: 2.2, endTime: 4, text: 'Two.', speaker: 'spk_1' }),
    ];

    const result = await classifyChunkOrBlocks('One. Two.', JSON.stringify(sentences), 'spk_1');

    expect(result).toEqual({ themes: ['financial_habits'], blockThemes: null });
    expect(mockClassifyChunkThemes).toHaveBeenCalledTimes(1);
    expect(mockClassifyChunkThemes).toHaveBeenCalledWith('One. Two.');
  });
});

describe('classifyChunkOrBlocks — multi-block chunks', () => {
  test('classifies each block independently and unions the themes for the chunk-level field', async () => {
    const sentences: SentenceMarker[] = [
      sentence({ startTime: 0, endTime: 5, text: 'Answer about education.', speaker: 'spk_1' }),
      sentence({ startTime: 12, endTime: 14, text: 'What about debt?', speaker: 'spk_0' }),
      sentence({ startTime: 20, endTime: 25, text: 'Answer about debt.', speaker: 'spk_1' }),
    ];
    mockClassifyChunkThemes
      .mockResolvedValueOnce(['education_paths'])
      .mockResolvedValueOnce(['financial_responsibility']);

    const result = await classifyChunkOrBlocks(
      'Answer about education. What about debt? Answer about debt.',
      JSON.stringify(sentences),
      'spk_1',
    );

    expect(mockClassifyChunkThemes).toHaveBeenCalledTimes(2);
    expect(mockClassifyChunkThemes).toHaveBeenNthCalledWith(1, 'Answer about education.');
    expect(mockClassifyChunkThemes).toHaveBeenNthCalledWith(2, 'Answer about debt.');

    expect(result.themes).toEqual(['education_paths', 'financial_responsibility']);
    expect(result.blockThemes).toEqual([
      { startTime: 0, endTime: 5, text: 'Answer about education.', themes: ['education_paths'] },
      { startTime: 20, endTime: 25, text: 'Answer about debt.', themes: ['financial_responsibility'] },
    ]);
  });

  test('deduplicates when two blocks share a theme', async () => {
    const sentences: SentenceMarker[] = [
      sentence({ startTime: 0, endTime: 5, text: 'Block A.', speaker: 'spk_1' }),
      sentence({ startTime: 12, endTime: 14, text: 'Question.', speaker: 'spk_0' }),
      sentence({ startTime: 20, endTime: 25, text: 'Block B.', speaker: 'spk_1' }),
    ];
    mockClassifyChunkThemes
      .mockResolvedValueOnce(['wealth_purpose'])
      .mockResolvedValueOnce(['wealth_purpose']);

    const result = await classifyChunkOrBlocks('Block A. Question. Block B.', JSON.stringify(sentences), 'spk_1');

    expect(result.themes).toEqual(['wealth_purpose']);
  });

  test('a block with no confident theme match still appears in blockThemes with an empty array', async () => {
    const sentences: SentenceMarker[] = [
      sentence({ startTime: 0, endTime: 5, text: 'Block A.', speaker: 'spk_1' }),
      sentence({ startTime: 12, endTime: 14, text: 'Question.', speaker: 'spk_0' }),
      sentence({ startTime: 20, endTime: 25, text: 'Block B.', speaker: 'spk_1' }),
    ];
    mockClassifyChunkThemes
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['wealth_purpose']);

    const result = await classifyChunkOrBlocks('Block A. Question. Block B.', JSON.stringify(sentences), 'spk_1');

    expect(result.themes).toEqual(['wealth_purpose']);
    expect(result.blockThemes?.[0].themes).toEqual([]);
  });
});
