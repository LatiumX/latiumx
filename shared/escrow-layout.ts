// Byte layout of the on-chain escrow program (programs/latiumx-escrow). Used by the server to
// read escrows from the chain and by the browser to build transactions. Discriminators are the
// first 8 bytes of sha256("global:<ix>"), sha256("account:<Name>") and sha256("event:<Name>").
import bs58 from 'bs58';

export const IX = {
  create_escrow: [253, 215, 165, 116, 36, 108, 68, 80],
  mark_delivered: [240, 118, 188, 142, 64, 85, 107, 18],
  release: [253, 249, 15, 206, 28, 127, 193, 241],
  claim: [62, 198, 214, 193, 213, 159, 108, 210],
  refund: [2, 96, 183, 251, 63, 208, 46, 46],
  reclaim: [44, 177, 236, 249, 145, 109, 163, 186],
  open_dispute: [137, 25, 99, 119, 23, 223, 161, 42],
  resolve: [246, 150, 236, 206, 108, 63, 58, 10],
  init_config: [23, 235, 115, 232, 168, 96, 1, 231],
  update_config: [29, 158, 252, 191, 10, 83, 219, 99],
  set_mint: [166, 129, 167, 223, 137, 118, 212, 47],
} as const;

const ACCOUNT_ESCROW = [31, 213, 123, 187, 186, 22, 218, 155];
const ACCOUNT_CONFIG = [155, 12, 170, 224, 30, 250, 204, 130];

const EVENTS = {
  EscrowFunded: [228, 243, 166, 74, 22, 167, 157, 244],
  EscrowDelivered: [181, 195, 202, 214, 106, 51, 220, 208],
  EscrowDisputed: [132, 73, 81, 200, 177, 51, 128, 18],
  EscrowReleased: [131, 7, 138, 104, 166, 190, 113, 112],
  EscrowRefunded: [132, 209, 49, 109, 135, 138, 28, 81],
  EscrowResolved: [91, 111, 193, 4, 183, 36, 78, 31],
} as const;

export const REF_KIND = { direct: 0, project: 1, gig: 2 } as const;
export const LIVE_STATES = ['funded', 'delivered', 'disputed'] as const;
export type EscrowState = (typeof LIVE_STATES)[number] | 'released' | 'refunded' | 'resolved';

export type EscrowAccount = {
  client: string;
  freelancer: string;
  mint: string;
  fee_recipient: string;
  id: bigint;
  amount: bigint;
  fee_bps: number;
  ref_kind: number;
  ref_id: bigint;
  state: (typeof LIVE_STATES)[number];
  created_at: number;
  delivery_deadline: number;
  review_seconds: number;
  delivered_at: number;
};

export type ConfigAccount = { admin: string; arbiter: string; fee_recipient: string; fee_bps: number; paused: boolean };

const startsWith = (data: Uint8Array, prefix: readonly number[]) => prefix.every((b, i) => data[i] === b);

class Reader {
  private view: DataView;
  constructor(private data: Uint8Array, public o = 0) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  key() {
    const k = bs58.encode(this.data.subarray(this.o, this.o + 32));
    this.o += 32;
    return k;
  }
  u8() {
    return this.view.getUint8(this.o++);
  }
  u16() {
    const v = this.view.getUint16(this.o, true);
    this.o += 2;
    return v;
  }
  u64() {
    const v = this.view.getBigUint64(this.o, true);
    this.o += 8;
    return v;
  }
  i64() {
    const v = this.view.getBigInt64(this.o, true);
    this.o += 8;
    return Number(v);
  }
}

export function decodeEscrow(data: Uint8Array): EscrowAccount | null {
  if (data.length < 8 + 4 * 32 + 8 + 8 + 2 + 1 + 8 + 1 + 4 * 8 || !startsWith(data, ACCOUNT_ESCROW)) return null;
  const r = new Reader(data, 8);
  const e = {
    client: r.key(),
    freelancer: r.key(),
    mint: r.key(),
    fee_recipient: r.key(),
    id: r.u64(),
    amount: r.u64(),
    fee_bps: r.u16(),
    ref_kind: r.u8(),
    ref_id: r.u64(),
    state: LIVE_STATES[r.u8()],
    created_at: r.i64(),
    delivery_deadline: r.i64(),
    review_seconds: r.i64(),
    delivered_at: r.i64(),
  };
  return e.state ? e : null;
}

export function decodeConfig(data: Uint8Array): ConfigAccount | null {
  if (data.length < 8 + 4 * 32 + 4 || !startsWith(data, ACCOUNT_CONFIG)) return null;
  const r = new Reader(data, 8);
  const admin = r.key();
  r.key(); // pending_admin
  return { admin, arbiter: r.key(), fee_recipient: r.key(), fee_bps: r.u16(), paused: r.u8() === 1 };
}

export type EscrowEvent =
  | { kind: 'released'; escrow: string; to_freelancer: bigint; fee: bigint; by_claim: boolean }
  | { kind: 'refunded'; escrow: string; to_client: bigint; by_freelancer: boolean }
  | { kind: 'resolved'; escrow: string; to_freelancer: bigint; to_client: bigint; fee: bigint }
  | { kind: 'funded' | 'delivered' | 'disputed'; escrow: string };

function decodeEvent(data: Uint8Array): EscrowEvent | null {
  const r = new Reader(data, 8);
  try {
    if (startsWith(data, EVENTS.EscrowReleased)) return { kind: 'released', escrow: r.key(), to_freelancer: r.u64(), fee: r.u64(), by_claim: r.u8() === 1 };
    if (startsWith(data, EVENTS.EscrowRefunded)) return { kind: 'refunded', escrow: r.key(), to_client: r.u64(), by_freelancer: r.u8() === 1 };
    if (startsWith(data, EVENTS.EscrowResolved)) return { kind: 'resolved', escrow: r.key(), to_freelancer: r.u64(), to_client: r.u64(), fee: r.u64() };
    if (startsWith(data, EVENTS.EscrowFunded)) return { kind: 'funded', escrow: r.key() };
    if (startsWith(data, EVENTS.EscrowDelivered)) return { kind: 'delivered', escrow: r.key() };
    if (startsWith(data, EVENTS.EscrowDisputed)) return { kind: 'disputed', escrow: r.key() };
  } catch {
    return null;
  }
  return null;
}

const base64ToBytes = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

/**
 * Reads escrow events from a transaction's log lines. Only "Program data:" lines written while
 * the escrow program itself is the running program count, so another program in the same
 * transaction can't fake an event.
 */
export function eventsFromLogs(logs: string[], programId: string): EscrowEvent[] {
  const stack: string[] = [];
  const out: EscrowEvent[] = [];
  for (const line of logs) {
    let m = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (m) {
      stack.push(m[1]);
      continue;
    }
    m = /^Program (\w+) (success|failed.*)$/.exec(line);
    if (m) {
      stack.pop();
      continue;
    }
    m = /^Program data: (.+)$/.exec(line);
    if (m && stack[stack.length - 1] === programId) {
      try {
        const ev = decodeEvent(base64ToBytes(m[1].split(' ')[0]));
        if (ev) out.push(ev);
      } catch {
        // not base64
      }
    }
  }
  return out;
}

/** Formats a raw token amount with its decimals, e.g. 1500000 with 6 decimals -> "1.5". */
export function formatUnits(raw: bigint | string, decimals: number): string {
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole.toLocaleString('en-US')}.${frac}` : whole.toLocaleString('en-US');
}

/** Parses "1.5" into raw units. Returns null for anything that isn't a positive amount. */
export function parseUnits(text: string, decimals: number): bigint | null {
  const m = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(text.replace(/,/g, ''));
  if (!m || (m[2] && m[2].length > decimals)) return null;
  const v = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] || '').padEnd(decimals, '0') || '0');
  return v > 0n && v < 2n ** 64n ? v : null;
}
