export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const bad = (message: string) => new HttpError(400, message);
export const unauthorized = (message = 'Log in with your wallet first.') => new HttpError(401, message);
export const forbidden = (message: string) => new HttpError(403, message);
export const notFound = (message = 'Not found.') => new HttpError(404, message);

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: err.message }, err.status);
  console.error(err);
  return json({ error: 'Something went wrong on our side. Try again in a minute.' }, 500);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw bad('Send the request body as JSON.');
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw bad('The request body is not valid JSON.');
  }
}

export const now = () => Math.floor(Date.now() / 1000);
