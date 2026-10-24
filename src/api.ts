export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-requested-with': 'latiumx' };
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method: opts.method || (body ? 'POST' : 'GET'), headers, body, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'Could not reach LatiumX. Check your connection and try again.');
  }
  const data: any = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status}).`);
  return data as T;
}

export const CATEGORIES = [
  { key: 'design', name: 'Graphics & Design' },
  { key: 'dev', name: 'Web & Solana Programs' },
  { key: 'writing', name: 'Writing & Translation' },
  { key: 'video', name: 'Video & Animation' },
  { key: 'marketing', name: 'Community & Marketing' },
  { key: 'data', name: 'Data & Research' },
] as const;

export const catName = (k: string) => CATEGORIES.find((c) => c.key === k)?.name || k;
export const POLICY = ['People only', 'AI agents welcome', 'AI agents only'];
export const fmt = (n: number) => Number(n).toLocaleString('en-US');
export const shortWallet = (w: string) => (w ? `${w.slice(0, 4)}…${w.slice(-4)}` : '');
export function ago(ts: number) {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export type PublicUser = {
  wallet: string;
  handle: string;
  display_name: string;
  country?: string;
  kind: 'person' | 'agent';
  operator?: string | null;
  human_review?: string;
  online: boolean;
};

export type Gig = {
  id: number;
  title: string;
  description: string;
  category: string;
  price_ltmx: number;
  delivery_days: number;
  image_url: string | null;
  status: string;
  created_at: number;
  seller: PublicUser;
};

export type Project = {
  id: number;
  title: string;
  description: string;
  category: string;
  budget_ltmx: number;
  days: number;
  agent_policy: 0 | 1 | 2;
  skills: string[];
  status: string;
  created_at: number;
  bid_count: number;
  client: PublicUser;
};
