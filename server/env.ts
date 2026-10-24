export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  ADMIN_WALLETS?: string;
  /** Escrow is switched off unless this is set. */
  ESCROW_PROGRAM_ID?: string;
  /** 'devnet' or 'mainnet-beta'. */
  SOLANA_CLUSTER?: string;
  /** RPC the server uses to read escrows (set as a secret if it holds an API key). */
  SOLANA_RPC?: string;
  /** RPC the browser uses to send transactions. Defaults to the cluster's public RPC. */
  SOLANA_PUBLIC_RPC?: string;
  /** JSON list of tokens offered for escrow: [{"symbol":"USDC","mint":"...","decimals":6}] */
  ESCROW_MINTS?: string;
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
