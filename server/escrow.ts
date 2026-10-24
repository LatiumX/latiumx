// Escrow support. Money never passes through this server: the browser sends transactions to the
// escrow program directly, then asks the server to "sync", and the server reads the result back
// from the chain. Nothing a user posts here can change an escrow's state without the chain
// agreeing.
import bs58 from 'bs58';
import type { Env, User } from './env';
import { HttpError, bad, notFound, now } from './http';
import { decodeConfig, decodeEscrow, eventsFromLogs, LIVE_STATES, type EscrowAccount, type EscrowEvent } from '../shared/escrow-layout';

export type EscrowMint = { symbol: string; mint: string; decimals: number };

const PUBLIC_RPC: Record<string, string> = {
  devnet: 'https://api.devnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
};

export function escrowEnabled(env: Env): boolean {
  return !!env.ESCROW_PROGRAM_ID && isWallet(env.ESCROW_PROGRAM_ID);
}

function isWallet(s: string) {
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

export function escrowMints(env: Env): EscrowMint[] {
  try {
    const list = JSON.parse(env.ESCROW_MINTS || '[]');
    if (!Array.isArray(list)) return [];
    return list.filter(
      (m) => m && typeof m.symbol === 'string' && typeof m.mint === 'string' && isWallet(m.mint) && Number.isInteger(m.decimals) && m.decimals >= 0 && m.decimals <= 12,
    );
  } catch {
    return [];
  }
}

export function publicEscrowConfig(env: Env) {
  if (!escrowEnabled(env)) return { enabled: false as const };
  const cluster = env.SOLANA_CLUSTER === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';
  return {
    enabled: true as const,
    program_id: env.ESCROW_PROGRAM_ID!,
    cluster,
    rpc: env.SOLANA_PUBLIC_RPC || PUBLIC_RPC[cluster],
    mints: escrowMints(env),
  };
}

function rpcUrl(env: Env) {
  const cluster = env.SOLANA_CLUSTER === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';
  return env.SOLANA_RPC || env.SOLANA_PUBLIC_RPC || PUBLIC_RPC[cluster];
}

async function rpc<T>(env: Env, method: string, params: unknown[]): Promise<T> {
  let res: Response;
  try {
    res = await fetch(rpcUrl(env), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  } catch {
    throw new HttpError(502, 'Could not reach the Solana network. Try again in a minute.');
  }
  const body: any = await res.json().catch(() => null);
  if (!res.ok || !body || body.error) throw new HttpError(502, 'The Solana network returned an error. Try again in a minute.');
  return body.result as T;
}

type AccountInfo = { owner: string; data: [string, string] } | null;

async function getAccount(env: Env, address: string): Promise<AccountInfo> {
  const r = await rpc<{ value: AccountInfo }>(env, 'getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
  return r.value;
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function readChainConfig(env: Env) {
  const programId = env.ESCROW_PROGRAM_ID!;
  const [configPda] = await findPda([new TextEncoder().encode('config')], programId);
  const acc = await getAccount(env, configPda);
  if (!acc || acc.owner !== programId) return null;
  return decodeConfig(b64(acc.data[0]));
}

// PDA derivation without pulling @solana/web3.js into the server bundle.
async function findPda(seeds: Uint8Array[], programId: string): Promise<[string, number]> {
  const pid = bs58.decode(programId);
  const marker = new TextEncoder().encode('ProgramDerivedAddress');
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), pid, marker];
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      buf.set(p, o);
      o += p.length;
    }
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    if (!isOnCurve(hash)) return [bs58.encode(hash), bump];
  }
  throw new Error('no PDA');
}

// ed25519 point decompression check (is this 32-byte string a valid public key?).
const P = 2n ** 255n - 19n;
const D = (-121665n * modInv(121666n)) % P;
function mod(a: bigint) {
  const r = a % P;
  return r >= 0n ? r : r + P;
}
function modPow(b: bigint, e: bigint) {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
function modInv(a: bigint) {
  return modPow(a, P - 2n);
}
function isOnCurve(bytes: Uint8Array) {
  const b = Uint8Array.from(bytes);
  b[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
  if (y >= P) return false;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  // x^2 = u / v; a square root exists iff (u/v)^((p-1)/2) is 0 or 1.
  const x2 = mod(u * modInv(v));
  if (x2 === 0n) return true;
  return modPow(x2, (P - 1n) / 2n) === 1n;
}

export async function escrowPda(env: Env, client: string, id: bigint) {
  const idBytes = new Uint8Array(8);
  new DataView(idBytes.buffer).setBigUint64(0, id, true);
  return (await findPda([new TextEncoder().encode('escrow'), bs58.decode(client), idBytes], env.ESCROW_PROGRAM_ID!))[0];
}

function upsertLive(env: Env, address: string, e: EscrowAccount, signature: string) {
  return env.DB.prepare(
    `INSERT INTO escrows (address, client_wallet, freelancer_wallet, mint, amount, fee_bps, ref_kind, ref_id, state, outcome,
       created_at, delivery_deadline, review_seconds, delivered_at, last_signature, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)
     ON CONFLICT (address) DO UPDATE SET client_wallet = excluded.client_wallet, freelancer_wallet = excluded.freelancer_wallet,
       mint = excluded.mint, amount = excluded.amount, fee_bps = excluded.fee_bps, ref_kind = excluded.ref_kind, ref_id = excluded.ref_id,
       state = excluded.state, outcome = '', created_at = excluded.created_at, delivery_deadline = excluded.delivery_deadline,
       review_seconds = excluded.review_seconds, delivered_at = excluded.delivered_at,
       last_signature = CASE WHEN excluded.last_signature != '' THEN excluded.last_signature ELSE escrows.last_signature END,
       synced_at = excluded.synced_at`,
  )
    .bind(
      address, e.client, e.freelancer, e.mint, e.amount.toString(), e.fee_bps, e.ref_kind,
      Number(e.ref_id > BigInt(Number.MAX_SAFE_INTEGER) ? 0n : e.ref_id), e.state,
      e.created_at, e.delivery_deadline, e.review_seconds, e.delivered_at, signature, now(),
    )
    .run();
}

function outcomeOf(ev: EscrowEvent): { state: 'released' | 'refunded' | 'resolved'; outcome: Record<string, unknown> } | null {
  if (ev.kind === 'released') return { state: 'released', outcome: { to_freelancer: ev.to_freelancer.toString(), fee: ev.fee.toString(), by_claim: ev.by_claim } };
  if (ev.kind === 'refunded') return { state: 'refunded', outcome: { to_client: ev.to_client.toString(), by_freelancer: ev.by_freelancer } };
  if (ev.kind === 'resolved')
    return { state: 'resolved', outcome: { to_freelancer: ev.to_freelancer.toString(), to_client: ev.to_client.toString(), fee: ev.fee.toString() } };
  return null;
}

/**
 * Brings one escrow row up to date with the chain. If the account still exists, its state is
 * copied. If it has been closed, the settling transaction (`signature`) must be a successful
 * transaction in which the escrow program itself reported how the escrow was paid out.
 */
export async function syncEscrow(env: Env, address: string, signature: string) {
  if (!isWallet(address)) throw bad('That is not a valid escrow address.');
  if (signature && !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) throw bad('That is not a valid transaction signature.');
  const programId = env.ESCROW_PROGRAM_ID!;

  const acc = await getAccount(env, address);
  if (acc) {
    if (acc.owner !== programId) throw bad('That account is not a LatiumX escrow.');
    const e = decodeEscrow(b64(acc.data[0]));
    if (!e) throw bad('That account is not a LatiumX escrow.');
    if ((await escrowPda(env, e.client, e.id)) !== address) throw bad('That account is not a LatiumX escrow.');
    await upsertLive(env, address, e, signature);
    return;
  }

  const row = await env.DB.prepare('SELECT state FROM escrows WHERE address = ?').bind(address).first<{ state: string }>();
  if (!row) throw notFound('No escrow found at that address.');
  if (!(LIVE_STATES as readonly string[]).includes(row.state)) return; // already settled
  if (!signature) throw bad('This escrow has been closed. Send the transaction signature that closed it.');

  const tx = await rpc<any>(env, 'getTransaction', [signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
  if (!tx) throw new HttpError(409, 'That transaction is not confirmed yet. Try again in a few seconds.');
  if (tx.meta?.err) throw bad('That transaction failed on-chain.');
  const settled = eventsFromLogs(tx.meta?.logMessages || [], programId)
    .filter((ev) => ev.escrow === address)
    .map(outcomeOf)
    .find(Boolean);
  if (!settled) throw bad('That transaction did not settle this escrow.');
  await env.DB.prepare('UPDATE escrows SET state = ?, outcome = ?, last_signature = ?, synced_at = ? WHERE address = ?')
    .bind(settled.state, JSON.stringify(settled.outcome), signature, now(), address)
    .run();
}

const ESCROW_SELECT = `SELECT e.*, cu.handle AS client_handle, fu.handle AS freelancer_handle,
    CASE e.ref_kind WHEN 1 THEN (SELECT title FROM projects WHERE id = e.ref_id) WHEN 2 THEN (SELECT title FROM gigs WHERE id = e.ref_id) END AS ref_title
  FROM escrows e
  LEFT JOIN users cu ON cu.wallet = e.client_wallet
  LEFT JOIN users fu ON fu.wallet = e.freelancer_wallet`;

function shape(r: Record<string, any>) {
  return {
    address: r.address,
    client: { wallet: r.client_wallet, handle: r.client_handle },
    freelancer: { wallet: r.freelancer_wallet, handle: r.freelancer_handle },
    mint: r.mint,
    amount: r.amount,
    fee_bps: r.fee_bps,
    ref: { kind: r.ref_kind, id: r.ref_id, title: r.ref_title || null },
    state: r.state,
    outcome: r.outcome ? JSON.parse(r.outcome) : null,
    created_at: r.created_at,
    delivery_deadline: r.delivery_deadline,
    review_seconds: r.review_seconds,
    delivered_at: r.delivered_at,
    last_signature: r.last_signature,
  };
}
export type EscrowRow = ReturnType<typeof shape>;

export async function listMyEscrows(env: Env, u: User) {
  const rows = await env.DB.prepare(`${ESCROW_SELECT} WHERE e.client_wallet = ? OR e.freelancer_wallet = ? ORDER BY e.created_at DESC LIMIT 200`)
    .bind(u.wallet, u.wallet)
    .all();
  return rows.results.map(shape);
}

export async function listProjectEscrows(env: Env, projectId: number, u: User) {
  const rows = await env.DB.prepare(`${ESCROW_SELECT} WHERE e.ref_kind = 1 AND e.ref_id = ? AND (e.client_wallet = ? OR e.freelancer_wallet = ?) ORDER BY e.created_at DESC`)
    .bind(projectId, u.wallet, u.wallet)
    .all();
  return rows.results.map(shape);
}

export async function listEscrowsByState(env: Env, state: string) {
  if (![...LIVE_STATES, 'released', 'refunded', 'resolved'].includes(state)) throw bad('Unknown state.');
  const rows = await env.DB.prepare(`${ESCROW_SELECT} WHERE e.state = ? ORDER BY e.synced_at DESC LIMIT 200`).bind(state).all();
  return rows.results.map(shape);
}

export function requireEscrow(env: Env) {
  if (!escrowEnabled(env)) throw new HttpError(503, 'Escrow payments are not live yet.');
}
