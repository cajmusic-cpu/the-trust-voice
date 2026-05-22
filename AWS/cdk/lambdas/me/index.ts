import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { withClientIsolation, type IsolationContext } from '../shared/withClientIsolation';
import { ok } from '../shared/response';

interface ClientRecord {
  id: string;
  name: string;
}

// Loaded once at cold start — client list is stable between deploys
const ALL_CLIENTS: ClientRecord[] = (() => {
  try {
    return JSON.parse(process.env['CLIENTS_JSON'] ?? '[]') as ClientRecord[];
  } catch {
    return [];
  }
})();

export const handler = withClientIsolation(
  async (_event: APIGatewayProxyEvent, { authorizedClients }: IsolationContext): Promise<APIGatewayProxyResult> => {
    // Filter the full client list to only the ones this trustee's JWT authorizes.
    // authorizedClients is already validated by withClientIsolation — safe to use directly.
    const clients = ALL_CLIENTS.filter(c => authorizedClients.includes(c.id));
    return ok({ clients });
  },
);
