import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env['QUERY_LOG_TABLE']!;

export async function logQuery(params: {
  clientId: string;
  userEmail: string;
  question: string;
  citationCount: number;
  // Principle-bridge shadow-mode fields — only ever populated when
  // ENABLE_PRINCIPLE_BRIDGE=true (see query/index.ts). Optional and omitted
  // from the item entirely otherwise, so every pre-existing call site and
  // every previously-written log row is unaffected.
  shadowType?: 'direct' | 'related_principle' | 'none';
  shadowThemes?: string[];
}): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      client_id: params.clientId,
      timestamp: new Date().toISOString(),
      user_email: params.userEmail,
      question: params.question,
      citation_count: params.citationCount,
      ...(params.shadowType ? { shadow_type: params.shadowType } : {}),
      ...(params.shadowThemes?.length ? { shadow_themes: params.shadowThemes } : {}),
    },
  }));
}
