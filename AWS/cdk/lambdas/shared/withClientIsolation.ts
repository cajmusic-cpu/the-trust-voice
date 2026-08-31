import type { APIGatewayProxyEvent, APIGatewayProxyResult, Handler } from 'aws-lambda';
import { forbidden, unauthorized } from './response';

export interface IsolationContext {
  // The specific clientId from the URL path, validated against the JWT.
  // null for routes that have no {clientId} path parameter (e.g. GET /me).
  clientId: string | null;

  // Every client ID this trustee is authorized to access, from the Cognito JWT.
  // Derived from cognito:groups — set by API Gateway after verifying JWT signature.
  authorizedClients: string[];

  // The trustee's email address, from the Cognito JWT 'email' claim.
  userEmail: string;
}

export type IsolatedHandler = (
  event: APIGatewayProxyEvent,
  ctx: IsolationContext,
) => Promise<APIGatewayProxyResult>;

// cognito:groups arrives as a JSON array string '["a","b"]' or comma-separated "a,b"
function parseGroups(raw: string | undefined): string[] {
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((g): g is string => typeof g === 'string');
      }
    } catch {
      // fall through to string split
    }
  }
  return raw.split(/[, ]+/).filter(Boolean);
}

export function withClientIsolation(fn: IsolatedHandler): Handler {
  return async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // EventBridge "keep-warm" pings carry { warmup: true } and no HTTP/auth context.
    // Short-circuit here so they hold a container warm without registering as 401s
    // in logs or metrics. No handler code and no data access runs for a ping.
    if ((event as unknown as { warmup?: boolean }).warmup === true) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: '{"warm":true}' };
    }

    // Claims are injected by API Gateway after it validates the Cognito JWT signature.
    // We never read authorization data from the request body or query parameters.
    const authorizer = event.requestContext.authorizer as
      | { claims?: Record<string, string> }
      | null
      | undefined;

    const claims = authorizer?.claims;
    if (!claims) return unauthorized();

    const authorizedClients = parseGroups(claims['cognito:groups']);
    if (authorizedClients.length === 0) {
      return forbidden('No authorized clients assigned to this account');
    }

    // If the route has a {clientId} path parameter, validate it server-side.
    // The client cannot forge authorization by sending a different clientId —
    // we check it against the JWT claims, not against anything the client sent.
    const requestedClientId = event.pathParameters?.clientId ?? null;
    if (requestedClientId !== null && !authorizedClients.includes(requestedClientId)) {
      return forbidden();
    }

    return fn(event, { clientId: requestedClientId, authorizedClients, userEmail: claims['email'] ?? '' });
  };
}
