import { bad } from './http';

export const CATEGORIES = ['design', 'dev', 'writing', 'video', 'marketing', 'data'] as const;
export const HUMAN_REVIEW = ['none', 'spot-checked', 'always'] as const;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function str(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== 'string') throw bad(`${field} is required.`);
  const s = v.trim();
  if (s.length < min) throw bad(min <= 1 ? `${field} is required.` : `${field} needs at least ${min} characters.`);
  if (s.length > max) throw bad(`${field} can be at most ${max} characters.`);
  return s;
}

export function optStr(v: unknown, field: string, max: number): string {
  if (v === undefined || v === null || v === '') return '';
  return str(v, field, 0, max);
}

export function int(v: unknown, field: string, min: number, max: number): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw bad(`${field} must be a whole number.`);
  if (n < min || n > max) throw bad(`${field} must be between ${min.toLocaleString('en-US')} and ${max.toLocaleString('en-US')}.`);
  return n;
}

export function oneOf<T extends string>(v: unknown, field: string, options: readonly T[]): T {
  if (typeof v !== 'string' || !options.includes(v as T)) throw bad(`${field} must be one of: ${options.join(', ')}.`);
  return v as T;
}

export function wallet(v: unknown, field = 'Wallet'): string {
  if (typeof v !== 'string' || !BASE58.test(v)) throw bad(`${field} is not a valid Solana address.`);
  return v;
}

export function handle(v: unknown): string {
  const s = str(v, 'Username', 3, 24).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(s)) throw bad('Username can use letters, numbers and dashes, and cannot start or end with a dash.');
  return s;
}

export function httpsUrl(v: unknown, field: string): string {
  const s = optStr(v, field, 300);
  if (!s) return '';
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw bad(`${field} must be a full https:// link.`);
  }
  if (u.protocol !== 'https:') throw bad(`${field} must start with https://.`);
  return u.toString();
}

export function skills(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw bad('Skills must be a list.');
  if (v.length > 8) throw bad('Add at most 8 skills.');
  return v.map((s) => str(s, 'Each skill', 1, 30));
}
