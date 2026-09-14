// query/index.ts — Stage 1/2/3 principle-bridge decision-logic tests.
//
// These exercise the actual exported handler (not a hand-extracted copy of
// its logic) with every AWS/Claude dependency mocked, because the decision
// logic (direct vs. related_principle vs. none, and whether shadow mode
// suppresses the live answer) lives inline in the handler and in
// runDirectMatch/runPrincipleBridge, which are not exported. Two properties
// matter most here and are both asserted directly against the real module:
//
//   1. Flag OFF (today's default in production): the handler must behave
//      byte-identically to "no principle-bridge code exists at all" — no
//      Stage 2 call, no shadow_type/shadow_themes fields logged, response
//      shape unchanged. This is the regression guarantee the whole feature
//      was built around.
//   2. Flag ON: direct/related_principle/none is chosen correctly from the
//      Stage 1 score, and SHADOW_MODE governs only what's returned to the
//      client — Stage 2 still runs and still gets logged either way.
//
// ENABLE_PRINCIPLE_BRIDGE / SHADOW_MODE are read from process.env at module
// load time, so each block below loads its own fresh copy of the handler
// module via jest.isolateModules with the env set first.

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: jest.fn().mockResolvedValue({}) })) },
  GetCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));

jest.mock('../lambdas/shared/embed', () => ({
  embedText: jest.fn().mockResolvedValue(new Array(8).fill(0.1)),
  embedTexts: jest.fn().mockResolvedValue([]),
}));

jest.mock('../lambdas/shared/pinecone', () => ({
  searchChunks: jest.fn(),
}));

jest.mock('../lambdas/shared/claude', () => ({
  queryWithContext: jest.fn(),
  queryRelatedPrinciple: jest.fn(),
}));

jest.mock('../lambdas/shared/themeClassifier', () => ({
  classifyQuestionThemes: jest.fn(),
}));

jest.mock('../lambdas/query/log', () => ({
  logQuery: jest.fn().mockResolvedValue(undefined),
}));

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { searchChunks } from '../lambdas/shared/pinecone';
import { queryWithContext, queryRelatedPrinciple } from '../lambdas/shared/claude';
import { classifyQuestionThemes } from '../lambdas/shared/themeClassifier';
import { logQuery } from '../lambdas/query/log';
import type { ChunkMatch } from '../lambdas/shared/pinecone';

const mockSearchChunks = searchChunks as jest.MockedFunction<typeof searchChunks>;
const mockQueryWithContext = queryWithContext as jest.MockedFunction<typeof queryWithContext>;
const mockQueryRelatedPrinciple = queryRelatedPrinciple as jest.MockedFunction<typeof queryRelatedPrinciple>;
const mockClassifyQuestionThemes = classifyQuestionThemes as jest.MockedFunction<typeof classifyQuestionThemes>;
const mockLogQuery = logQuery as jest.MockedFunction<typeof logQuery>;

function makeMatch(score: number, themes: string[] = [], overrides: Partial<ChunkMatch['metadata']> = {}): ChunkMatch {
  return {
    id: 'vid-1/0',
    score,
    values: [],
    metadata: {
      video_id: 'vid-1',
      chunk_index: 0,
      start_time: 0,
      end_time: 30,
      speaker: 'spk_0',
      is_subject: true,
      text: 'Some excerpt text.',
      sentences_json: '',
      themes,
      block_themes_json: '',
      ...overrides,
    },
  };
}

function makeEvent(question: string): APIGatewayProxyEvent {
  return {
    pathParameters: { clientId: 'client-1' },
    requestContext: {
      authorizer: { claims: { 'cognito:groups': 'client-1', email: 'trustee@example.com' } },
    } as unknown as APIGatewayProxyEvent['requestContext'],
    body: JSON.stringify({ question }),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEvent;
}

// Loads a fresh copy of the handler module with the given env vars applied
// before its top-level ENABLE_PRINCIPLE_BRIDGE/SHADOW_MODE consts are read.
function loadHandler(env: { ENABLE_PRINCIPLE_BRIDGE?: string; SHADOW_MODE?: string }) {
  let mod!: typeof import('../lambdas/query/index');
  jest.isolateModules(() => {
    process.env['CHUNKS_TABLE'] = 'ttv-chunks';
    process.env['VIDEOS_TABLE'] = 'ttv-videos';
    if (env.ENABLE_PRINCIPLE_BRIDGE === undefined) delete process.env['ENABLE_PRINCIPLE_BRIDGE'];
    else process.env['ENABLE_PRINCIPLE_BRIDGE'] = env.ENABLE_PRINCIPLE_BRIDGE;
    if (env.SHADOW_MODE === undefined) delete process.env['SHADOW_MODE'];
    else process.env['SHADOW_MODE'] = env.SHADOW_MODE;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../lambdas/query/index');
  });
  return mod.handler;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ENABLE_PRINCIPLE_BRIDGE=false (production default today)', () => {
  const handler = loadHandler({ ENABLE_PRINCIPLE_BRIDGE: 'false' });

  test('never calls Stage 2 dependencies and returns only {answer, citations}', async () => {
    mockSearchChunks.mockResolvedValue([makeMatch(0.4)]); // weak match — would fail DIRECT_MATCH_THRESHOLD if Stage 2 ran
    mockQueryWithContext.mockResolvedValue({ answer: "Here's what was said. [1]", usedCitationIndices: [1] });

    const res = await handler(makeEvent('What do you think about money?'), {} as never, () => {}) as import('aws-lambda').APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['answer', 'citations']);
    expect(body['answer']).toBe("Here's what was said. [1]");

    // Stage 2 must never even be consulted when the flag is off.
    expect(mockClassifyQuestionThemes).not.toHaveBeenCalled();
    expect(mockQueryRelatedPrinciple).not.toHaveBeenCalled();

    // Log call carries no shadow_* fields.
    expect(mockLogQuery).toHaveBeenCalledTimes(1);
    const logArg = mockLogQuery.mock.calls[0]![0];
    expect(logArg).not.toHaveProperty('shadowType');
    expect(logArg).not.toHaveProperty('shadowThemes');
  });

  test('absent env var defaults to off, same as explicit "false"', async () => {
    const offByDefault = loadHandler({});
    mockSearchChunks.mockResolvedValue([]);

    const res = await offByDefault(makeEvent('anything'), {} as never, () => {}) as import('aws-lambda').APIGatewayProxyResult;
    expect(JSON.parse(res.body)).not.toHaveProperty('type');
    expect(mockClassifyQuestionThemes).not.toHaveBeenCalled();
  });
});

describe('ENABLE_PRINCIPLE_BRIDGE=true, SHADOW_MODE=true (default safe on-state)', () => {
  const handler = loadHandler({ ENABLE_PRINCIPLE_BRIDGE: 'true', SHADOW_MODE: 'true' });

  test('strong direct match: Stage 2 never runs, client still gets direct answer', async () => {
    mockSearchChunks.mockResolvedValue([makeMatch(0.9)]); // >= 0.82 DIRECT_MATCH_THRESHOLD
    mockQueryWithContext.mockResolvedValue({ answer: 'Direct answer. [1]', usedCitationIndices: [1] });

    const res = await handler(makeEvent('q'), {} as never, () => {}) as import('aws-lambda').APIGatewayProxyResult;
    const body = JSON.parse(res.body) as Record<string, unknown>;

    expect(body['answer']).toBe('Direct answer. [1]');
    expect(body).not.toHaveProperty('type'); // shadow mode never exposes type to the client
    expect(mockClassifyQuestionThemes).not.toHaveBeenCalled();

    const logArg = mockLogQuery.mock.calls[0]![0];
    expect(logArg.shadowType).toBe('direct');
  });

  test('weak direct match + related theme found above floor: logs related_principle, but still returns the direct answer', async () => {
    mockSearchChunks
      .mockResolvedValueOnce([makeMatch(0.4)]) // Stage 1 direct search — below 0.82
      .mockResolvedValueOnce([makeMatch(0.6, ['wealth_purpose'])]); // Stage 2 theme-filtered search — above 0.55 floor
    mockQueryWithContext.mockResolvedValue({ answer: 'Weak direct answer.', usedCitationIndices: [] });
    mockClassifyQuestionThemes.mockResolvedValue(['wealth_purpose']);
    mockQueryRelatedPrinciple.mockResolvedValue({ answer: 'Related principle answer. [1]', usedCitationIndices: [1] });

    const res = await handler(makeEvent('off topic question'), {} as never, () => {}) as import('aws-lambda').APIGatewayProxyResult;
    const body = JSON.parse(res.body) as Record<string, unknown>;

    // Shadow mode: the trustee still only ever sees Stage 1's own answer.
    expect(body['answer']).toBe('Weak direct answer.');
    expect(body).not.toHaveProperty('type');

    const logArg = mockLogQuery.mock.calls[0]![0];
    expect(logArg.shadowType).toBe('related_principle');
    expect(logArg.shadowThemes).toEqual(['wealth_purpose']);
  });

  test('no matching theme at all: logs type "none"', async () => {
    mockSearchChunks.mockResolvedValueOnce([makeMatch(0.2)]);
    mockQueryWithContext.mockResolvedValue({ answer: 'Weak direct answer.', usedCitationIndices: [] });
    mockClassifyQuestionThemes.mockResolvedValue([]);

    await handler(makeEvent('totally unrelated question'), {} as never, () => {});

    const logArg = mockLogQuery.mock.calls[0]![0];
    expect(logArg.shadowType).toBe('none');
    expect(mockQueryRelatedPrinciple).not.toHaveBeenCalled();
  });

  test('theme found but related search is below RELATED_PRINCIPLE_FLOOR: logs "none"', async () => {
    mockSearchChunks
      .mockResolvedValueOnce([makeMatch(0.3)])
      .mockResolvedValueOnce([makeMatch(0.5, ['wealth_purpose'])]); // below 0.55 floor
    mockQueryWithContext.mockResolvedValue({ answer: 'Weak direct answer.', usedCitationIndices: [] });
    mockClassifyQuestionThemes.mockResolvedValue(['wealth_purpose']);

    await handler(makeEvent('q'), {} as never, () => {});

    const logArg = mockLogQuery.mock.calls[0]![0];
    expect(logArg.shadowType).toBe('none');
    expect(mockQueryRelatedPrinciple).not.toHaveBeenCalled();
  });
});

describe('ENABLE_PRINCIPLE_BRIDGE=true, SHADOW_MODE=false (live — not deployed by this PR)', () => {
  const handler = loadHandler({ ENABLE_PRINCIPLE_BRIDGE: 'true', SHADOW_MODE: 'false' });

  test('related_principle result is actually returned to the client, with its type', async () => {
    mockSearchChunks
      .mockResolvedValueOnce([makeMatch(0.4)])
      .mockResolvedValueOnce([makeMatch(0.7, ['wealth_purpose'])]);
    mockQueryWithContext.mockResolvedValue({ answer: 'Weak direct answer.', usedCitationIndices: [] });
    mockClassifyQuestionThemes.mockResolvedValue(['wealth_purpose']);
    mockQueryRelatedPrinciple.mockResolvedValue({ answer: 'Related principle answer. [1]', usedCitationIndices: [1] });

    const res = await handler(makeEvent('q'), {} as never, () => {}) as import('aws-lambda').APIGatewayProxyResult;
    const body = JSON.parse(res.body) as Record<string, unknown>;

    expect(body['answer']).toBe('Related principle answer. [1]');
    expect(body['type']).toBe('related_principle');
  });

  test('strong direct match still returns type "direct"', async () => {
    mockSearchChunks.mockResolvedValue([makeMatch(0.95)]);
    mockQueryWithContext.mockResolvedValue({ answer: 'Direct answer. [1]', usedCitationIndices: [1] });

    const res = await handler(makeEvent('q'), {} as never, () => {}) as import('aws-lambda').APIGatewayProxyResult;
    const body = JSON.parse(res.body) as Record<string, unknown>;

    expect(body['type']).toBe('direct');
    expect(body['answer']).toBe('Direct answer. [1]');
  });
});
