// Friends, blocking, people search and the leaderboard.
import type { Env, User } from './env';
import { HttpError, bad, forbidden, notFound, now } from './http';
import { VISIBLE_USER, publicProfile } from './users';
import * as v from './validate';

const FRIEND_REQUESTS_PER_DAY = 50;
const PAGE = 24;

let tablesReady = false;

/** Creates the tables on first use, so the live database doesn't need a manual migration. */
export async function ensureSocialTables(env: Env) {
  if (tablesReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS friendships (
      requester TEXT NOT NULL,
      addressee TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (requester, addressee))`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS friendships_addressee ON friendships (addressee, status)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS friendships_requester ON friendships (requester, status)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS blocks (
      blocker TEXT NOT NULL,
      blocked TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (blocker, blocked))`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS blocks_blocked ON blocks (blocked)'),
  ]);
  tablesReady = true;
}

export type Relation = 'self' | 'friends' | 'outgoing' | 'incoming' | 'none';

async function relationRow(env: Env, me: string, other: string) {
  return env.DB.prepare(
    `SELECT requester, status FROM friendships WHERE (requester = ?1 AND addressee = ?2) OR (requester = ?2 AND addressee = ?1) LIMIT 1`,
  )
    .bind(me, other)
    .first<{ requester: string; status: string }>();
}

export async function relationTo(env: Env, me: User | null, other: string): Promise<{ relation: Relation; blocked: boolean }> {
  if (!me) return { relation: 'none', blocked: false };
  if (me.wallet === other) return { relation: 'self', blocked: false };
  await ensureSocialTables(env);
  const [row, block] = await Promise.all([
    relationRow(env, me.wallet, other),
    env.DB.prepare('SELECT 1 AS x FROM blocks WHERE blocker = ? AND blocked = ?').bind(me.wallet, other).first(),
  ]);
  const relation: Relation = !row ? 'none' : row.status === 'accepted' ? 'friends' : row.requester === me.wallet ? 'outgoing' : 'incoming';
  return { relation, blocked: !!block };
}

/** True if either wallet has blocked the other. */
export async function isBlockedEitherWay(env: Env, a: string, b: string) {
  await ensureSocialTables(env);
  const row = await env.DB.prepare('SELECT 1 AS x FROM blocks WHERE (blocker = ?1 AND blocked = ?2) OR (blocker = ?2 AND blocked = ?1) LIMIT 1').bind(a, b).first();
  return !!row;
}

async function requireVisibleTarget(env: Env, wallet: string) {
  const u = await env.DB.prepare(
    `SELECT u.wallet FROM users u LEFT JOIN users o ON o.wallet = u.operator_wallet WHERE u.wallet = ? AND ${VISIBLE_USER}`,
  )
    .bind(wallet)
    .first();
  if (!u) throw notFound('That user is not available.');
}

export async function friendAction(env: Env, me: User, other: string, action: 'request' | 'accept' | 'decline' | 'remove') {
  await ensureSocialTables(env);
  if (other === me.wallet) throw bad("You can't add yourself as a friend.");
  const row = await relationRow(env, me.wallet, other);
  const t = now();

  if (action === 'request') {
    await requireVisibleTarget(env, other);
    if (await isBlockedEitherWay(env, me.wallet, other)) throw forbidden("You can't send a friend request to this user.");
    if (row?.status === 'accepted') return 'friends';
    if (row && row.requester === other) {
      // They already asked us: sending a request back accepts it.
      await env.DB.prepare("UPDATE friendships SET status = 'accepted', updated_at = ? WHERE requester = ? AND addressee = ?").bind(t, other, me.wallet).run();
      return 'friends';
    }
    if (row) return 'outgoing';
    const sent = await env.DB.prepare('SELECT COUNT(*) AS n FROM friendships WHERE requester = ? AND created_at > ?').bind(me.wallet, t - 86400).first<{ n: number }>();
    if ((sent?.n ?? 0) >= FRIEND_REQUESTS_PER_DAY) throw new HttpError(429, `You can send ${FRIEND_REQUESTS_PER_DAY} friend requests a day. Try again tomorrow.`);
    await env.DB.prepare("INSERT INTO friendships (requester, addressee, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)").bind(me.wallet, other, t, t).run();
    return 'outgoing';
  }
  if (action === 'accept') {
    if (!row || row.requester !== other || row.status !== 'pending') throw notFound('There is no friend request from this user.');
    await env.DB.prepare("UPDATE friendships SET status = 'accepted', updated_at = ? WHERE requester = ? AND addressee = ?").bind(t, other, me.wallet).run();
    return 'friends';
  }
  // decline (an incoming request) and remove (a friend, or cancel our own request) both delete the row.
  if (action === 'decline' && (!row || row.requester !== other || row.status !== 'pending')) throw notFound('There is no friend request from this user.');
  await env.DB.prepare('DELETE FROM friendships WHERE (requester = ?1 AND addressee = ?2) OR (requester = ?2 AND addressee = ?1)').bind(me.wallet, other).run();
  return 'none';
}

export async function setBlock(env: Env, me: User, other: string, blocked: boolean) {
  await ensureSocialTables(env);
  if (other === me.wallet) throw bad("You can't block yourself.");
  if (blocked) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO blocks (blocker, blocked, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(me.wallet, other, now()),
      env.DB.prepare('DELETE FROM friendships WHERE (requester = ?1 AND addressee = ?2) OR (requester = ?2 AND addressee = ?1)').bind(me.wallet, other),
    ]);
  } else {
    await env.DB.prepare('DELETE FROM blocks WHERE blocker = ? AND blocked = ?').bind(me.wallet, other).run();
  }
}

const PERSON_COLS = `u.*, o.handle AS o_handle,
  (SELECT COUNT(*) FROM friendships f WHERE f.status = 'accepted' AND (f.requester = u.wallet OR f.addressee = u.wallet)) AS friends,
  (SELECT COUNT(*) FROM bids b WHERE b.bidder_wallet = u.wallet AND b.status = 'accepted') AS jobs_won,
  (SELECT COUNT(*) FROM gigs g WHERE g.seller_wallet = u.wallet AND g.status = 'active') AS services`;

type PersonRow = User & { o_handle: string | null; friends: number; jobs_won: number; services: number };

const person = (r: PersonRow) => ({ ...publicProfile(r, r.o_handle), friends: r.friends, jobs_won: r.jobs_won, services: r.services });

export async function userStats(env: Env, wallet: string) {
  await ensureSocialTables(env);
  return env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM friendships f WHERE f.status = 'accepted' AND (f.requester = ?1 OR f.addressee = ?1)) AS friends,
       (SELECT COUNT(*) FROM bids b WHERE b.bidder_wallet = ?1 AND b.status = 'accepted') AS jobs_won,
       (SELECT COUNT(*) FROM projects p WHERE p.client_wallet = ?1 AND p.status IN ('awarded', 'closed')) AS projects_awarded`,
  )
    .bind(wallet)
    .first<{ friends: number; jobs_won: number; projects_awarded: number }>();
}

function likeTerm(q: string) {
  return `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
}

export async function searchPeople(env: Env, me: User | null, p: URLSearchParams) {
  await ensureSocialTables(env);
  const where = [VISIBLE_USER];
  const args: unknown[] = [];
  const q = (p.get('q') || '').trim().slice(0, 60).toLowerCase();
  if (q) {
    where.push(`(lower(u.handle) LIKE ? ESCAPE '\\' OR lower(u.display_name) LIKE ? ESCAPE '\\' OR lower(u.bio) LIKE ? ESCAPE '\\' OR lower(u.country) LIKE ? ESCAPE '\\' OR u.wallet = ?)`);
    const t = likeTerm(q);
    args.push(t, t, t, t, (p.get('q') || '').trim());
  }
  const who = p.get('who');
  if (who === 'people') where.push(`u.kind = 'person'`);
  if (who === 'agents') where.push(`u.kind = 'agent'`);
  if (p.get('online') === '1') {
    where.push('u.last_seen_at > ?');
    args.push(now() - 15 * 60);
  }
  const show = p.get('show');
  if (me && show === 'friends') {
    where.push(`EXISTS (SELECT 1 FROM friendships f WHERE f.status = 'accepted' AND ((f.requester = ? AND f.addressee = u.wallet) OR (f.addressee = ? AND f.requester = u.wallet)))`);
    args.push(me.wallet, me.wallet);
  }
  if (me) {
    where.push('NOT EXISTS (SELECT 1 FROM blocks bl WHERE bl.blocker = ? AND bl.blocked = u.wallet)');
    args.push(me.wallet);
  }
  const order =
    { new: 'u.created_at DESC', friends: 'friends DESC, u.last_seen_at DESC', jobs: 'jobs_won DESC, u.last_seen_at DESC' }[p.get('sort') || ''] ||
    'u.last_seen_at DESC';
  const page = Math.max(0, Math.min(50, Number(p.get('page')) || 0));
  const rows = await env.DB.prepare(
    `SELECT ${PERSON_COLS} FROM users u LEFT JOIN users o ON o.wallet = u.operator_wallet
     WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`,
  )
    .bind(...args, PAGE + 1, page * PAGE)
    .all<PersonRow>();
  const list = rows.results.slice(0, PAGE).map(person);

  // Mark each result with how it relates to the viewer.
  let relations: Record<string, Relation> = {};
  if (me && list.length) {
    const wallets = list.map((x) => x.wallet);
    const marks = wallets.map(() => '?').join(',');
    const rels = await env.DB.prepare(
      `SELECT requester, addressee, status FROM friendships
       WHERE (requester = ? AND addressee IN (${marks})) OR (addressee = ? AND requester IN (${marks}))`,
    )
      .bind(me.wallet, ...wallets, me.wallet, ...wallets)
      .all<{ requester: string; addressee: string; status: string }>();
    for (const r of rels.results) {
      const other = r.requester === me.wallet ? r.addressee : r.requester;
      relations[other] = r.status === 'accepted' ? 'friends' : r.requester === me.wallet ? 'outgoing' : 'incoming';
    }
    relations[me.wallet] = 'self';
  }
  return { people: list.map((x) => ({ ...x, relation: relations[x.wallet] || 'none' })), more: rows.results.length > PAGE };
}

export async function myFriends(env: Env, me: User) {
  await ensureSocialTables(env);
  const sel = (cond: string) =>
    env.DB.prepare(
      `SELECT ${PERSON_COLS}, f.created_at AS since FROM friendships f
       JOIN users u ON u.wallet = CASE WHEN f.requester = ?1 THEN f.addressee ELSE f.requester END
       LEFT JOIN users o ON o.wallet = u.operator_wallet
       WHERE ${cond} AND u.banned = 0 AND u.handle IS NOT NULL ORDER BY f.updated_at DESC LIMIT 500`,
    ).bind(me.wallet);
  const [friends, incoming, outgoing, blocked] = await Promise.all([
    sel("f.status = 'accepted' AND (f.requester = ?1 OR f.addressee = ?1)").all<PersonRow>(),
    sel("f.status = 'pending' AND f.addressee = ?1").all<PersonRow>(),
    sel("f.status = 'pending' AND f.requester = ?1").all<PersonRow>(),
    env.DB.prepare(
      `SELECT u.wallet, u.handle, u.display_name, u.kind FROM blocks b JOIN users u ON u.wallet = b.blocked WHERE b.blocker = ? ORDER BY b.created_at DESC`,
    )
      .bind(me.wallet)
      .all(),
  ]);
  return {
    friends: friends.results.map(person),
    incoming: incoming.results.map(person),
    outgoing: outgoing.results.map(person),
    blocked: blocked.results,
  };
}

export async function pendingFriendRequests(env: Env, me: User) {
  await ensureSocialTables(env);
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM friendships f JOIN users u ON u.wallet = f.requester
     WHERE f.addressee = ? AND f.status = 'pending' AND u.banned = 0`,
  )
    .bind(me.wallet)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

const BOARD_SIZE = 10;

/**
 * Leaderboards from on-site activity. "Since" limits each board to activity in a time window.
 * These are activity counts, not earnings, and are easy to inflate with a second wallet, so
 * admins should keep an eye on them before attaching rewards.
 */
export async function leaderboard(env: Env, period: string) {
  await ensureSocialTables(env);
  const since = period === '30d' ? now() - 30 * 86400 : period === '7d' ? now() - 7 * 86400 : 0;
  const board = async (valueSql: string, extraArgs: unknown[] = []) => {
    const rows = await env.DB.prepare(
      `SELECT * FROM (SELECT u.*, o.handle AS o_handle, (${valueSql}) AS score FROM users u LEFT JOIN users o ON o.wallet = u.operator_wallet WHERE ${VISIBLE_USER})
       WHERE score > 0 ORDER BY score DESC, last_seen_at DESC LIMIT ${BOARD_SIZE}`,
    )
      .bind(...extraArgs)
      .all<User & { o_handle: string | null; score: number }>();
    return rows.results.map((r) => ({ ...publicProfile(r, r.o_handle), score: r.score }));
  };
  let bugHunters: Awaited<ReturnType<typeof board>> = [];
  try {
    bugHunters = await board(`SELECT COUNT(*) FROM bug_reports x WHERE x.reporter_wallet = u.wallet AND x.status = 'rewarded' AND x.updated_at >= ?`, [since]);
  } catch {
    // No bug reports yet: the table is created with the first report.
  }
  const [freelancers, clients, connected] = await Promise.all([
    board(`SELECT COUNT(*) FROM bids b JOIN projects p ON p.id = b.project_id WHERE b.bidder_wallet = u.wallet AND b.status = 'accepted' AND b.created_at >= ? AND p.client_wallet != u.wallet`, [since]),
    board(`SELECT COUNT(*) FROM projects p WHERE p.client_wallet = u.wallet AND p.status IN ('awarded', 'closed') AND EXISTS (SELECT 1 FROM bids b WHERE b.project_id = p.id AND b.status = 'accepted') AND p.created_at >= ?`, [since]),
    board(`SELECT COUNT(*) FROM friendships f WHERE f.status = 'accepted' AND (f.requester = u.wallet OR f.addressee = u.wallet) AND f.updated_at >= ?`, [since]),
  ]);
  return { period: since ? period : 'all', freelancers, clients, connected, bug_hunters: bugHunters };
}

export const walletParam = (s: string) => v.wallet(decodeURIComponent(s));
