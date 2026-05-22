import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { withClientIsolation, type IsolationContext } from '../shared/withClientIsolation';
import { ok, badRequest, internalError } from '../shared/response';
import { embedText } from '../shared/embed';
import { searchChunks } from '../shared/pinecone';
import { queryWithContext } from '../shared/claude';
import { buildCitations } from '../shared/citations';

interface QueryBody {
  question: string;
}

function parseBody(event: APIGatewayProxyEvent): QueryBody | null {
  if (!event.body) return null;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf-8')
      : event.body;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'question' in parsed &&
      typeof (parsed as { question: unknown }).question === 'string'
    ) {
      return parsed as QueryBody;
    }
    return null;
  } catch {
    return null;
  }
}

export const handler = withClientIsolation(
  async (
    event: APIGatewayProxyEvent,
    { clientId }: IsolationContext,
  ): Promise<APIGatewayProxyResult> => {
    // clientId is guaranteed non-null here — withClientIsolation validated it
    // against the JWT, and this route always has a {clientId} path parameter.
    if (!clientId) return internalError();

    const body = parseBody(event);
    const question = body?.question.trim();
    if (!question) {
      return badRequest('question is required and must be a non-empty string');
    }

    try {
      const embedding = await embedText(question);

      // Step 2: Retrieve the most relevant transcript chunks from Pinecone.
      // The namespace equals clientId — data isolation is enforced at both
      // the JWT layer (withClientIsolation) and the vector DB layer (namespace).
      const matches = await searchChunks(clientId, embedding);

      if (matches.length === 0) {
        return ok({
          answer:
            "I don't have any relevant transcript excerpts to answer this question. " +
            "This topic may not have been covered in the recorded interviews.",
          citations: [],
        });
      }

      // Step 3: Build context chunks for Claude (1-based index for citation matching)
      const contextChunks = matches.map((m, i) => ({
        index: i + 1,
        text: m.metadata.text,
        video_id: m.metadata.video_id,
        start_time: m.metadata.start_time,
        end_time: m.metadata.end_time,
        speaker: m.metadata.speaker,
      }));

      // Step 4: Ask Claude — it cites excerpts as [1], [2], etc.
      const { answer, usedCitationIndices } = await queryWithContext(question, contextChunks);

      // Step 5: Map used citations back to structured objects with video timestamps
      const citations = buildCitations(matches, usedCitationIndices);

      return ok({ answer, citations });
    } catch (err) {
      console.error('Query pipeline failed:', err);
      return internalError();
    }
  },
);
