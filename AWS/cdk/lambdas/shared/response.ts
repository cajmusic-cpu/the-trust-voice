import type { APIGatewayProxyResult } from 'aws-lambda';

const HEADERS = {
  'Content-Type': 'application/json',
  // Tighten to the CloudFront distribution URL in Phase 5
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

export const ok = (body: unknown): APIGatewayProxyResult => ({
  statusCode: 200,
  headers: HEADERS,
  body: JSON.stringify(body),
});

export const forbidden = (message = 'Forbidden'): APIGatewayProxyResult => ({
  statusCode: 403,
  headers: HEADERS,
  body: JSON.stringify({ error: message }),
});

export const unauthorized = (): APIGatewayProxyResult => ({
  statusCode: 401,
  headers: HEADERS,
  body: JSON.stringify({ error: 'Unauthorized' }),
});

export const badRequest = (message = 'Bad request'): APIGatewayProxyResult => ({
  statusCode: 400,
  headers: HEADERS,
  body: JSON.stringify({ error: message }),
});

export const internalError = (): APIGatewayProxyResult => ({
  statusCode: 500,
  headers: HEADERS,
  body: JSON.stringify({ error: 'Internal server error' }),
});
