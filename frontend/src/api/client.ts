import { getIdToken } from '../auth/cognito';

const API_BASE = (import.meta.env['VITE_API_BASE_URL'] as string).replace(/\/$/, '');

async function authFetch(path: string, options?: RequestInit): Promise<Response> {
  const token = await getIdToken();
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: token,
      ...(options?.headers ?? {}),
    },
  });
}

export interface Client {
  id: string;
  name: string;
}

export async function getClients(): Promise<Client[]> {
  const res = await authFetch('/me');
  if (!res.ok) throw new Error(`Failed to load clients (${res.status})`);
  const data = (await res.json()) as { clients: Client[] };
  return data.clients;
}

export interface Citation {
  index: number;
  videoId: string;
  startTime: number;
  endTime: number;
  speaker: string;
  quote: string;
}

export interface QueryResponse {
  answer: string;
  citations: Citation[];
}

export async function queryClient(clientId: string, question: string): Promise<QueryResponse> {
  const res = await authFetch(`/clients/${clientId}/query`, {
    method: 'POST',
    body: JSON.stringify({ question }),
  });
  if (!res.ok) throw new Error(`Query failed (${res.status})`);
  return res.json() as Promise<QueryResponse>;
}

// Returns a presigned S3 URL valid for 1 hour. Append #t={seconds} to seek.
export async function getVideoUrl(clientId: string, videoId: string): Promise<string> {
  const res = await authFetch(`/clients/${clientId}/videos/${videoId}/url`);
  if (!res.ok) throw new Error(`Failed to get video URL (${res.status})`);
  const data = (await res.json()) as { url: string };
  return data.url;
}
