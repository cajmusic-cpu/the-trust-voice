import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env['UPLOAD_TOKENS_TABLE']!;

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': 'https://upload.thetrustvoice.com',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const token = event.queryStringParameters?.['token'];
  if (!token) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing token' }) };
  }

  const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { token } }));

  if (!result.Item) {
    return {
      statusCode: 404,
      headers: HEADERS,
      body: JSON.stringify({ error: 'Link not found or expired' }),
    };
  }

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ url: result.Item['presigned_url'] as string }),
  };
}
