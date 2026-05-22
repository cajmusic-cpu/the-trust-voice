import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { withClientIsolation, type IsolationContext } from '../shared/withClientIsolation';
import { ok, badRequest, forbidden } from '../shared/response';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const VIDEOS_TABLE = process.env['VIDEOS_TABLE']!;
// Presigned URL lifetime in seconds. Matches Cognito idToken validity (1 hour).
const EXPIRES_IN = 3600;

export const handler = withClientIsolation(
  async (
    event: APIGatewayProxyEvent,
    { clientId }: IsolationContext,
  ): Promise<APIGatewayProxyResult> => {
    if (!clientId) return forbidden();

    const videoId = event.pathParameters?.['videoId'];
    if (!videoId) return badRequest('videoId path parameter is required');

    // Fetch video record — contains the S3 bucket and key written by IngestLambda
    const result = await ddb.send(
      new GetCommand({
        TableName: VIDEOS_TABLE,
        Key: { client_id: clientId, video_id: videoId },
      }),
    );

    if (!result.Item) return forbidden('Video not found');

    const status = result.Item['status'] as string | undefined;
    if (status !== 'READY' && status !== 'TRANSCRIBING' && status !== 'PROCESSING') {
      return badRequest(`Video is not available (status: ${status ?? 'unknown'})`);
    }

    const bucket = result.Item['video_bucket'] as string;
    const key = result.Item['s3_key'] as string;

    if (!bucket || !key) return badRequest('Video location is not recorded');

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: EXPIRES_IN },
    );

    return ok({ url, expiresIn: EXPIRES_IN });
  },
);
