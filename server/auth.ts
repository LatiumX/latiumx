import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { Env, User } from './env';
import { bad, forbidden, now, unauthorized } from './http';

const NONCE_TTL = 10 * 60;
const SESSION_TTL = 7 * 24 * 60 * 60;
export const SESSION_COOKIE = 'lx_session';

function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** The exact text the wallet signs. Shown to the person in their wallet, so it must read clearly. */
export function signInMessage(host: string, wallet: string, nonce: string, issuedAt: number): string {
  return [
    `${host} wants you to sign in with your Solana account:`,
    wallet,
    '',
    'Sign in to LatiumX. This does not send a transaction and costs nothing.',
    '',
    `URI: https://${host}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date(issuedAt * 1000).toISOString()}`,
    `Expiration Time: ${new Date((issuedAt + NONCE_TTL) * 1000).toISOString()}`,
  ].join('\n');
}

export function verifySignature(message: string, signatureB58: string, walletB58: string): boolean {
  try {
    const sig = bs58.decode(signatureB58);
    const pub = bs58.decode(walletB58);
    if (sig.length !== 64 || pub.length !== 32) return false;
    return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, pub);
  } catch {
    return false;
  }
}

export async function createNonce(env: Env, host: string, wallet: string) {
  const t = now();
  await env.DB.prepare('DELETE FROM auth_nonces WHERE expires_at < ?').bind(t).run();
  const nonce = randomHex(16);
  const message = signInMessage(host, wallet, nonce, t);
  await env.DB.prepare('INSERT INTO auth_nonces (nonce, wallet, message, expires_at) VALUES (?, ?, ?, ?)')
    .bind(nonce, wallet, message, t + NONCE_TTL)
    .run();
  return { nonce, message };
}

/** Checks a signed nonce, creates the user on first login, and returns a new session token. */
export async function verifyAndCreateSession(env: Env, wallet: string, nonce: string, signature: string) {
  const row = await env.DB.prepare('DELETE FROM auth_nonces WHERE nonce = ? RETURNING wallet, message, expires_at')
    .bind(nonce)
    .first<{ wallet: string; message: string; expires_at: number }>();
  if (!row || row.wallet !== wallet) throw bad('This sign-in request is unknown or was already used. Try logging in again.');
  if (row.expires_at < now()) throw bad('This sign-in request expired. Try logging in again.');
  if (!verifySignature(row.message, signature, wallet)) throw unauthorized('The signature does not match this wallet.');

  const t = now();
  await env.DB.prepare('INSERT INTO users (wallet, created_at, last_seen_at) VALUES (?, ?, ?) ON CONFLICT (wallet) DO UPDATE SET last_seen_at = excluded.last_seen_at')
    .bind(wallet, t, t)
    .run();
  const user = await env.DB.prepare('SELECT * FROM users WHERE wallet = ?').bind(wallet).first<User>();
  if (user?.banned) throw forbidden('This account has been suspended.');

  const token = randomHex(32);
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t).run();
  await env.DB.prepare('INSERT INTO sessions (token_hash, wallet, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(token), wallet, t + SESSION_TTL)
    .run();
  return { token, user: user!, maxAge: SESSION_TTL };
}

export function sessionCookie(token: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function readToken(request: Request): string | null {
  const authz = request.headers.get('authorization');
  if (authz?.startsWith('Bearer ')) return authz.slice(7).trim();
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]{64})`));
  return m ? m[1] : null;
}

/** Returns the logged-in user, or null. Also refreshes last_seen_at (used for Instant Hire). */
export async function currentUser(env: Env, request: Request): Promise<User | null> {
  const token = readToken(request);
  if (!token) return null;
  const s = await env.DB.prepare('SELECT wallet, expires_at FROM sessions WHERE token_hash = ?')
    .bind(await sha256Hex(token))
    .first<{ wallet: string; expires_at: number }>();
  if (!s || s.expires_at < now()) return null;
  const user = await env.DB.prepare('SELECT * FROM users WHERE wallet = ?').bind(s.wallet).first<User>();
  if (!user || user.banned) return null;
  if (now() - user.last_seen_at > 60) {
    await env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE wallet = ?').bind(now(), user.wallet).run();
  }
  return user;
}

export async function deleteSession(env: Env, request: Request) {
  const token = readToken(request);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}

export function isAdmin(env: Env, user: User | null): boolean {
  if (!user) return false;
  return (env.ADMIN_WALLETS || '').split(',').map((s) => s.trim()).filter(Boolean).includes(user.wallet);
}

/** Mutating requests from browsers must carry this header, which forces a CORS preflight and blocks cross-site form posts. */
export function requireAppHeader(request: Request) {
  const hasBearer = request.headers.get('authorization')?.startsWith('Bearer ');
  if (!hasBearer && request.headers.get('x-requested-with') !== 'latiumx') throw forbidden('Missing X-Requested-With: latiumx header.');
}
