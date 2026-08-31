import { performance } from 'node:perf_hooks';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { withClientIsolation, type IsolationContext } from '../shared/withClientIsolation';
import { ok, badRequest, forbidden } from '../shared/response';
import { emitMetric } from '../shared/metrics';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const VIDEOS_TABLE = process.env['VIDEOS_TABLE']!;
// Presigned URL lifetime in seconds. Matches Cognito idToken validity (1 hour).
const EXPIRES_IN = 3600;

// Flipped to false after the first invocation handled by this execution
// environment, so the emitted metric can distinguish cold from warm.
let coldStart = true;

export const handler = withClientIsolation(
  async (
    event: APIGatewayProxyEvent,
    { clientId }: IsolationContext,
  ): Promise<APIGatewayProxyResult> => {
    const startedAt = performance.now();
    const wasCold = coldStart;
    coldStart = false;
    let ddbMs = 0;
    let signMs = 0;

    const videoId = event.pathParameters?.['videoId'];

    // Emit one EMF line per request: TotalMs / DdbMs / SignMs / ColdStart become
    // CloudWatch metrics under TrustVoice/VideoUrl, dimensioned by Outcome.
    const finish = (
      res: APIGatewayProxyResult,
      outcome: string,
    ): APIGatewayProxyResult => {
      emitMetric({
        namespace: 'TrustVoice/VideoUrl',
        dimensions: { Outcome: outcome },
        metrics: {
          TotalMs: Math.round(performance.now() - startedAt),
          DdbMs: Math.round(ddbMs),
          SignMs: Math.round(signMs),
          ColdStart: wasCold ? 1 : 0,
        },
        properties: {
          clientId: clientId ?? undefined,
          videoId,
          statusCode: res.statusCode,
        },
      });
      return res;
    };

    if (!clientId) return finish(forbidden(), 'forbidden');

    if (!videoId) {
      return finish(badRequest('videoId path parameter is required'), 'bad_request');
    }

    // Fetch video record — contains the S3 bucket and key written by IngestLambda
    const t1 = performance.now();
    const result = await ddb.send(
      new GetCommand({
        TableName: VIDEOS_TABLE,
        Key: { client_id: clientId, video_id: videoId },
      }),
    );
    ddbMs = performance.now() - t1;

    if (!result.Item) return finish(forbidden('Video not found'), 'not_found');

    const status = result.Item['status'] as string | undefined;
    const PLAYABLE_STATUSES = ['READY', 'TRANSCRIBING', 'PROCESSING', 'EXTRACTING_AUDIO'];
    if (!PLAYABLE_STATUSES.includes(status ?? '')) {
      return finish(
        badRequest(`Video is not available (status: ${status ?? 'unknown'})`),
        'not_playable',
      );
    }

    const bucket = result.Item['video_bucket'] as string;
    const key = result.Item['s3_key'] as string;

    if (!bucket || !key) {
      return finish(badRequest('Video location is not recorded'), 'no_location');
    }

    const t2 = performance.now();
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: EXPIRES_IN },
    );
    signMs = performance.now() - t2;

    return finish(ok({ url, expiresIn: EXPIRES_IN }), 'success');
  },
);
