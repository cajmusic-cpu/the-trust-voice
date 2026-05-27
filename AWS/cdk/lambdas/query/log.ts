import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env['QUERY_LOG_TABLE']!;

export async function logQuery(params: {
  clientId: string;
  userEmail: string;
  question: string;
  citationCount: number;
}): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      client_id: params.clientId,
      timestamp: new Date().toISOString(),
      user_email: params.userEmail,
      question: params.question,
      citation_count: params.citationCount,
    },
  }));
}
