import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { emitMetric } from '../shared/metrics';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://portal.thetrustvoice.com',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Lifecycle events the client player is allowed to report. Anything else is dropped.
const KNOWN_EVENTS = new Set([
  'url_requested',
  'url_received',
  'url_failed',
  'media_ready',
  'stalled',
  'media_error',
  'retry',
]);

const MAX_BODY_BYTES = 2048;
const NO_CONTENT: APIGatewayProxyResult = { statusCode: 204, headers: CORS_HEADERS, body: '' };

function clampNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(Math.round(value), 0), 3_600_000);
}

function truncString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 200) : undefined;
}

// Unauthenticated, write-only telemetry sink. navigator.sendBeacon() cannot attach
// an Authorization header, so this route has no Cognito authorizer by design. It
// performs no data access — it validates a small JSON envelope and emits one EMF
// metric line to CloudWatch. Abuse surface is bounded by the 2 KB body cap, the
// event allow-list, numeric clamping, string truncation, and API Gateway
// per-method throttling configured in the CDK stack.
// eslint-disable-next-line trust-voice/require-isolation-wrapper
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  if (event.httpMethod === 'OPTIONS') return NO_CONTENT;

  const raw = event.body ?? '';
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return NO_CONTENT;

  let payload: Record<string, unknown>;
  try {
    const decoded = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== 'object' || parsed === null) return NO_CONTENT;
    payload = parsed as Record<string, unknown>;
  } catch {
    return NO_CONTENT;
  }

  const name = truncString(payload['event']);
  if (!name || !KNOWN_EVENTS.has(name)) return NO_CONTENT;

  const metrics: Record<string, number> = { Events: 1 };
  const timeToUrlMs = clampNumber(payload['ms']);
  if (name === 'url_received' && timeToUrlMs !== undefined) {
    metrics['TimeToUrlMs'] = timeToUrlMs;
  }
  const timeToReadyMs = clampNumber(payload['msTotal']) ?? clampNumber(payload['msSinceUrl']);
  if (name === 'media_ready' && timeToReadyMs !== undefined) {
    metrics['TimeToReadyMs'] = timeToReadyMs;
  }

  emitMetric({
    namespace: 'TrustVoice/VideoClient',
    dimensions: { Outcome: name },
    metrics,
    properties: {
      clientId: truncString(payload['clientId']),
      videoId: truncString(payload['videoId']),
      stage: truncString(payload['stage']),
      attempt: clampNumber(payload['attempt']),
      status: clampNumber(payload['status']),
      code: clampNumber(payload['code']),
      msTotal: clampNumber(payload['msTotal']),
      msSinceUrl: clampNumber(payload['msSinceUrl']),
      sourceIp: truncString(event.requestContext.identity.sourceIp),
    },
  });

  return NO_CONTENT;
};
