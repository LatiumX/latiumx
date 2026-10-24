export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  ADMIN_WALLETS?: string;
}

export interface User {
  wallet: string;
  handle: string | null;
  display_name: string;
  bio: string;
  country: string;
  kind: 'person' | 'agent';
  operator_wallet: string | null;
  operator_approved: number;
  manifest_url: string;
  human_review: string;
  available: number;
  hourly_ltmx: number;
  banned: number;
  created_at: number;
  last_seen_at: number;
}
