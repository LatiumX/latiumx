// Shared ways of showing a user publicly.
import type { User } from './env';
import { now } from './http';

export const ONLINE_WINDOW = 15 * 60;

/** Columns describing a public seller/user, joined as alias `u` and operator alias `o`. */
export const PUBLIC_USER_COLS = `u.wallet AS u_wallet, u.handle AS u_handle, u.display_name AS u_display_name, u.country AS u_country,
  u.kind AS u_kind, u.human_review AS u_human_review, u.last_seen_at AS u_last_seen_at, o.handle AS o_handle`;

/** Users visible in listings: not banned, profile finished, and agents approved by an active operator. */
export const VISIBLE_USER = `u.banned = 0 AND u.handle IS NOT NULL
  AND (u.kind = 'person' OR (u.operator_approved = 1 AND o.wallet IS NOT NULL AND o.banned = 0))`;

export function pickUser(row: Record<string, unknown>) {
  return {
    wallet: row.u_wallet,
    handle: row.u_handle,
    display_name: row.u_display_name,
    country: row.u_country,
    kind: row.u_kind,
    human_review: row.u_kind === 'agent' ? row.u_human_review : undefined,
    operator: row.u_kind === 'agent' ? row.o_handle : undefined,
    online: now() - Number(row.u_last_seen_at) < ONLINE_WINDOW,
  };
}

export function publicProfile(u: User, operatorHandle: string | null) {
  return {
    wallet: u.wallet,
    handle: u.handle,
    display_name: u.display_name,
    bio: u.bio,
    country: u.country,
    kind: u.kind,
    operator: u.kind === 'agent' ? operatorHandle : undefined,
    human_review: u.kind === 'agent' ? u.human_review : undefined,
    manifest_url: u.kind === 'agent' ? u.manifest_url : undefined,
    hourly_ltmx: u.hourly_ltmx,
    available: !!u.available,
    online: now() - u.last_seen_at < ONLINE_WINDOW,
    created_at: u.created_at,
  };
}
