// Builds escrow transactions in the browser. The wallet signs and sends them; afterwards the
// server is asked to sync the escrow from the chain.
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Buffer } from 'buffer';
import { useEffect, useState } from 'react';
import { api } from './api';
import { IX, decodeEscrow, type EscrowAccount } from '../shared/escrow-layout';

export type EscrowMint = { symbol: string; mint: string; decimals: number };
export type EscrowConfig =
  | { enabled: false }
  | { enabled: true; program_id: string; cluster: string; rpc: string; mints: EscrowMint[]; fee_bps: number | null; arbiter: string | null; paused: boolean | null };

export type EscrowRow = {
  address: string;
  client: { wallet: string; handle: string | null };
  freelancer: { wallet: string; handle: string | null };
  mint: string;
  amount: string;
  fee_bps: number;
  ref: { kind: number; id: number; title: string | null };
  state: 'funded' | 'delivered' | 'disputed' | 'released' | 'refunded' | 'resolved';
  outcome: Record<string, string | boolean> | null;
  created_at: number;
  delivery_deadline: number;
  review_seconds: number;
  delivered_at: number;
  last_signature: string;
};

let configPromise: Promise<EscrowConfig> | null = null;
export function loadEscrowConfig(): Promise<EscrowConfig> {
  configPromise ??= api<EscrowConfig>('/api/escrow/config').catch((e) => {
    configPromise = null;
    throw e;
  });
  return configPromise;
}

export function useEscrowConfig(): EscrowConfig | null {
  const [cfg, setCfg] = useState<EscrowConfig | null>(null);
  useEffect(() => {
    loadEscrowConfig().then(setCfg, () => setCfg({ enabled: false }));
  }, []);
  return cfg;
}

const connections = new Map<string, Connection>();
export function escrowConnection(cfg: Extract<EscrowConfig, { enabled: true }>) {
  let c = connections.get(cfg.rpc);
  if (!c) connections.set(cfg.rpc, (c = new Connection(cfg.rpc, 'confirmed')));
  return c;
}

const enc = new TextEncoder();
const u64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
const i64 = (n: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(n), true);
  return b;
};
const concat = (...parts: (Uint8Array | readonly number[])[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export function pdas(programId: string) {
  const pid = new PublicKey(programId);
  const find = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, pid)[0];
  return {
    program: pid,
    config: find(enc.encode('config')),
    allowedMint: (mint: PublicKey) => find(enc.encode('mint'), mint.toBytes()),
    escrow: (client: PublicKey, id: bigint) => find(enc.encode('escrow'), client.toBytes(), u64(id)),
    vault: (escrow: PublicKey) => find(enc.encode('vault'), escrow.toBytes()),
  };
}

const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });

async function tokenProgramOf(conn: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await conn.getAccountInfo(mint);
  if (!info) throw new Error('That token does not exist on this network.');
  if (info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID)) return info.owner;
  throw new Error('That is not a token mint.');
}

/** A random id that is unique per client wallet in practice (48 bits, so it fits a JS number). */
export const newEscrowId = () => {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return b.reduce((n, x) => n * 256n + BigInt(x), 0n) + 1n;
};

export async function buildCreate(
  cfg: Extract<EscrowConfig, { enabled: true }>,
  args: { client: PublicKey; freelancer: PublicKey; mint: PublicKey; amount: bigint; deliveryDays: number; reviewDays: number; refKind: number; refId: number; id?: bigint },
) {
  const conn = escrowConnection(cfg);
  const p = pdas(cfg.program_id);
  const tokenProgram = await tokenProgramOf(conn, args.mint);
  const clientToken = getAssociatedTokenAddressSync(args.mint, args.client, true, tokenProgram);
  const bal = await conn.getTokenAccountBalance(clientToken).catch(() => null);
  if (!bal || BigInt(bal.value.amount) < args.amount) throw new Error("Your wallet doesn't hold enough of this token for the escrow.");
  const id = args.id ?? newEscrowId();
  const escrow = p.escrow(args.client, id);
  const ix = new TransactionInstruction({
    programId: p.program,
    keys: [
      w(args.client, true),
      r(args.freelancer),
      r(p.config),
      r(args.mint),
      r(p.allowedMint(args.mint)),
      w(escrow),
      w(p.vault(escrow)),
      w(clientToken),
      r(tokenProgram),
      r(SystemProgram.programId),
    ],
    data: Buffer.from(
      concat(IX.create_escrow, u64(id), u64(args.amount), i64(args.deliveryDays * 86400), i64(args.reviewDays * 86400), [args.refKind], u64(BigInt(args.refId))),
    ),
  });
  return { tx: new Transaction().add(ix), escrow: escrow.toBase58() };
}

export type EscrowAction = 'deliver' | 'release' | 'claim' | 'refund' | 'reclaim' | 'dispute' | 'resolve';

export async function readEscrow(cfg: Extract<EscrowConfig, { enabled: true }>, address: string): Promise<EscrowAccount | null> {
  const info = await escrowConnection(cfg).getAccountInfo(new PublicKey(address));
  if (!info || info.owner.toBase58() !== cfg.program_id) return null;
  return decodeEscrow(info.data);
}

export async function buildAction(
  cfg: Extract<EscrowConfig, { enabled: true }>,
  action: EscrowAction,
  address: string,
  signer: PublicKey,
  freelancerBps = 0,
) {
  const e = await readEscrow(cfg, address);
  if (!e) throw new Error('This escrow is already closed. Refresh the page.');
  const p = pdas(cfg.program_id);
  const escrow = new PublicKey(address);

  if (action === 'deliver' || action === 'dispute') {
    const data = action === 'deliver' ? IX.mark_delivered : IX.open_dispute;
    return new Transaction().add(new TransactionInstruction({ programId: p.program, keys: [r(signer, true), w(escrow)], data: Buffer.from(Uint8Array.from(data)) }));
  }

  const mint = new PublicKey(e.mint);
  const tokenProgram = await tokenProgramOf(escrowConnection(cfg), mint);
  const client = new PublicKey(e.client);
  const freelancer = new PublicKey(e.freelancer);
  const feeRecipient = new PublicKey(e.fee_recipient);
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
  const data =
    action === 'resolve'
      ? concat(IX.resolve, Uint8Array.of(freelancerBps & 0xff, freelancerBps >> 8))
      : Uint8Array.from({ release: IX.release, claim: IX.claim, refund: IX.refund, reclaim: IX.reclaim }[action]);
  return new Transaction().add(
    new TransactionInstruction({
      programId: p.program,
      keys: [
        w(signer, true),
        r(p.config),
        w(escrow),
        w(p.vault(escrow)),
        r(mint),
        w(client),
        r(freelancer),
        r(feeRecipient),
        w(ata(client)),
        w(ata(freelancer)),
        w(ata(feeRecipient)),
        r(tokenProgram),
        r(ASSOCIATED_TOKEN_PROGRAM_ID),
        r(SystemProgram.programId),
      ],
      data: Buffer.from(data),
    }),
  );
}

type SendFn = (tx: Transaction, conn: Connection) => Promise<string>;

/** Sends through the wallet, waits for confirmation, then syncs the escrow on the server. */
export async function sendAndSync(cfg: Extract<EscrowConfig, { enabled: true }>, send: SendFn, tx: Transaction, address: string) {
  const conn = escrowConnection(cfg);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  let signature: string;
  try {
    signature = await send(tx, conn);
  } catch (e: any) {
    const m = String(e?.message || e);
    throw new Error(/reject|denied|cancel/i.test(m) ? 'You cancelled the transaction in your wallet.' : explain(m));
  }
  const res = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  if (res.value.err) throw new Error(`The transaction failed on-chain. ${explain(JSON.stringify(res.value.err))}`);
  await syncWithRetry(address, signature);
  return signature;
}

async function syncWithRetry(address: string, signature: string) {
  for (let i = 0; ; i++) {
    try {
      await api('/api/escrows/sync', { body: { address, signature } });
      return;
    } catch (e: any) {
      if (i >= 4 || e.status !== 409) throw e;
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  }
}

// Anchor custom errors start at 6000, in the order they are declared in the program.
const PROGRAM_ERRORS = [
  'Only the upgrade authority can set this up.',
  'Only the admin can do this.',
  'Fee is above the 10% cap.',
  'New escrows are paused right now.',
  'This token is not allowed for escrow.',
  'Amount must be more than zero.',
  "You can't open an escrow with yourself.",
  'Delivery or review period is out of range.',
  'Unknown reference.',
  "The escrow is not in the right state for this. Refresh the page.",
  'Only the client can do this.',
  'Only the freelancer can do this.',
  'Only the client or the freelancer can do this.',
  'Only the arbiter can do this.',
  'Too early for this.',
  'Split must be between 0% and 100%.',
  'Math overflow.',
  'This token is not safe for escrow.',
];

function explain(raw: string): string {
  const m = /custom program error: 0x([0-9a-f]+)|"Custom":(\d+)/i.exec(raw);
  if (m) {
    const code = m[1] ? parseInt(m[1], 16) : Number(m[2]);
    if (code >= 6000 && code - 6000 < PROGRAM_ERRORS.length) return PROGRAM_ERRORS[code - 6000];
  }
  if (/insufficient (funds|lamports)|0x1\b/i.test(raw)) return 'Not enough SOL in your wallet to pay the network fee.';
  return raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
}
