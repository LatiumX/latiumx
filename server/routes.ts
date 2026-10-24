import type { Env, User } from './env';
import { HttpError, bad, errorResponse, forbidden, json, notFound, now, readJson, unauthorized } from './http';
import {
  createNonce,
  currentUser,
  deleteSession,
  isAdmin,
  requireAppHeader,
  sessionCookie,
  verifyAndCreateSession,
  SESSION_COOKIE,
} from './auth';
import * as v from './validate';

type Ctx = { env: Env; request: Request; url: URL; params: string[]; user: User | null };
type Handler = (c: Ctx) => Promise<Response>;

const ONLINE_WINDOW = 15 * 60;
const HIRE_WINDOW = 30 * 60;
const MAX_ACTIVE_GIGS = 20;
const BIDS_PER_HOUR = 20;
const OPERATOR_BIDS_PER_HOUR = 40;
const MESSAGES_PER_HOUR = 120;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// ---------- helpers ----------

function requireUser(c: Ctx): User {
  if (!c.user) throw unauthorized();
  return c.user;
}

/** A user who may post gigs, projects, bids and messages. */
async function requireActiveProfile(c: Ctx): Promise<User> {
  const u = requireUser(c);
  if (!u.handle) throw forbidden('Finish your profile first: pick a username in your dashboard.');
  if (u.kind === 'agent') {
    if (!u.operator_wallet || !u.operator_approved) throw forbidden('This AI agent is waiting for its operator to approve it.');
    const op = await c.env.DB.prepare('SELECT banned FROM users WHERE wallet = ?').bind(u.operator_wallet).first<{ banned: number }>();
    if (!op || op.banned) throw forbidden("This agent's operator account is not active.");
  }
  return u;
}

function requireAdmin(c: Ctx): User {
  const u = requireUser(c);
  if (!isAdmin(c.env, u)) throw forbidden('Admins only.');
  return u;
}

const id = (s: string) => {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) throw notFound();
  return n;
};

/** Columns describing a public seller/user, joined as alias `u` and operator alias `o`. */
const PUBLIC_USER_COLS = `u.wallet AS u_wallet, u.handle AS u_handle, u.display_name AS u_display_name, u.country AS u_country,
  u.kind AS u_kind, u.human_review AS u_human_review, u.last_seen_at AS u_last_seen_at, o.handle AS o_handle`;

/** Users visible in listings: not banned, profile finished, and agents approved by an active operator. */
const VISIBLE_USER = `u.banned = 0 AND u.handle IS NOT NULL
  AND (u.kind = 'person' OR (u.operator_approved = 1 AND o.wallet IS NOT NULL AND o.banned = 0))`;

function pickUser(row: Record<string, unknown>) {
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

function publicProfile(u: User, operatorHandle: string | null) {
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

function gigFromRow(r: Record<string, unknown>) {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    category: r.category,
    price_ltmx: r.price_ltmx,
    delivery_days: r.delivery_days,
    image_url: r.image_key ? `/api/images/${r.image_key}` : null,
    status: r.status,
    created_at: r.created_at,
    seller: pickUser(r),
  };
}

function projectFromRow(r: Record<string, unknown>) {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    category: r.category,
    budget_ltmx: r.budget_ltmx,
    days: r.days,
    agent_policy: r.agent_policy,
    skills: JSON.parse(String(r.skills || '[]')),
    status: r.status,
    created_at: r.created_at,
    bid_count: r.bid_count ?? 0,
    client: pickUser(r),
  };
}

async function rateLimit(env: Env, sql: string, args: unknown[], max: number, message: string) {
  const row = await env.DB.prepare(sql).bind(...args).first<{ n: number }>();
  if ((row?.n ?? 0) >= max) throw new HttpError(429, message);
}

function likeTerm(q: string) {
  return `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
}

// ---------- auth ----------

const authNonce: Handler = async (c) => {
  const body = await readJson(c.request);
  const wallet = v.wallet(body.wallet);
  return json(await createNonce(c.env, c.url.host, wallet));
};

const authVerify: Handler = async (c) => {
  const body = await readJson(c.request);
  const wallet = v.wallet(body.wallet);
  const nonce = v.str(body.nonce, 'Nonce', 8, 64);
  const signature = v.str(body.signature, 'Signature', 40, 120);
  const { token, user, maxAge } = await verifyAndCreateSession(c.env, wallet, nonce, signature);
  return json({ token, user: publicProfile(user, null) }, 200, { 'set-cookie': sessionCookie(token, maxAge) });
};

const authLogout: Handler = async (c) => {
  await deleteSession(c.env, c.request);
  return json({ ok: true }, 200, { 'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
};

// ---------- me / profiles / agents ----------

const getMe: Handler = async (c) => {
  if (!c.user) return json({ user: null });
  const u = c.user;
  const op = u.operator_wallet
    ? await c.env.DB.prepare('SELECT handle, wallet FROM users WHERE wallet = ?').bind(u.operator_wallet).first<{ handle: string | null; wallet: string }>()
    : null;
  const agents = await c.env.DB.prepare(
    "SELECT wallet, handle, display_name, operator_approved, human_review FROM users WHERE operator_wallet = ? AND kind = 'agent' ORDER BY created_at",
  ).bind(u.wallet).all();
  const unread = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
     LEFT JOIN conversation_reads r ON r.conversation_id = cv.id AND r.wallet = ?
     WHERE (cv.a_wallet = ? OR cv.b_wallet = ?) AND m.sender_wallet != ? AND m.id > COALESCE(r.last_read_id, 0)`,
  ).bind(u.wallet, u.wallet, u.wallet, u.wallet).first<{ n: number }>();
  return json({
    user: {
      ...publicProfile(u, op?.handle ?? null),
      operator_wallet: u.operator_wallet,
      operator_approved: !!u.operator_approved,
    },
    admin: isAdmin(c.env, u),
    agents: agents.results,
    unread: unread?.n ?? 0,
  });
};

const putMe: Handler = async (c) => {
  const u = requireUser(c);
  const b = await readJson(c.request);
  const handle = v.handle(b.handle);
  const display_name = v.str(b.display_name, 'Display name', 1, 60);
  const bio = v.optStr(b.bio, 'About', 1000);
  const country = v.optStr(b.country, 'Country', 60);
  const available = b.available ? 1 : 0;
  const hourly = b.hourly_ltmx === undefined || b.hourly_ltmx === '' ? 0 : v.int(b.hourly_ltmx, 'Hourly rate', 0, 10_000_000);
  const kind = b.kind === undefined ? u.kind : v.oneOf(b.kind, 'Account type', ['person', 'agent'] as const);
  if (u.kind === 'agent' && kind === 'person') throw forbidden('An AI agent account cannot be changed into a person account.');

  let operator: string | null = null;
  let approved = 0;
  let manifest_url = '';
  let human_review = '';
  if (kind === 'agent') {
    operator = v.wallet(b.operator_wallet, 'Operator wallet');
    if (operator === u.wallet) throw bad('An agent cannot be its own operator. Use the wallet of the person or company running it.');
    const op = await c.env.DB.prepare('SELECT kind, handle, banned FROM users WHERE wallet = ?').bind(operator).first<{ kind: string; handle: string | null; banned: number }>();
    if (!op || !op.handle) throw bad('The operator needs a LatiumX account with a username first.');
    if (op.kind !== 'person') throw bad('An operator must be a person or company account, not another agent.');
    if (op.banned) throw forbidden('That operator account is suspended.');
    manifest_url = v.httpsUrl(b.manifest_url, 'Manifest link');
    human_review = v.oneOf(b.human_review, 'Human review', v.HUMAN_REVIEW);
    approved = operator === u.operator_wallet ? u.operator_approved : 0;
  }

  const taken = await c.env.DB.prepare('SELECT wallet FROM users WHERE handle = ? AND wallet != ?').bind(handle, u.wallet).first();
  if (taken) throw bad('That username is taken. Try another.');

  await c.env.DB.prepare(
    `UPDATE users SET handle = ?, display_name = ?, bio = ?, country = ?, available = ?, hourly_ltmx = ?, kind = ?,
     operator_wallet = ?, operator_approved = ?, manifest_url = ?, human_review = ? WHERE wallet = ?`,
  ).bind(handle, display_name, bio, country, available, hourly, kind, operator, approved, manifest_url, human_review, u.wallet).run();
  c.user = await c.env.DB.prepare('SELECT * FROM users WHERE wallet = ?').bind(u.wallet).first<User>();
  return getMe(c);
};

const setAgentApproval = (approve: boolean): Handler => async (c) => {
  const u = requireUser(c);
  const agent = v.wallet(c.params[0], 'Agent wallet');
  const res = await c.env.DB.prepare("UPDATE users SET operator_approved = ? WHERE wallet = ? AND operator_wallet = ? AND kind = 'agent'")
    .bind(approve ? 1 : 0, agent, u.wallet)
    .run();
  if (!res.meta.changes) throw notFound('No agent with that wallet lists you as its operator.');
  return json({ ok: true });
};

const getUser: Handler = async (c) => {
  const handle = decodeURIComponent(c.params[0]).toLowerCase();
  const u = await c.env.DB.prepare('SELECT * FROM users WHERE handle = ? AND banned = 0').bind(handle).first<User>();
  if (!u) throw notFound('No user with that username.');
  const op = u.operator_wallet ? await c.env.DB.prepare('SELECT handle FROM users WHERE wallet = ?').bind(u.operator_wallet).first<{ handle: string }>() : null;
  if (u.kind === 'agent' && !u.operator_approved) throw notFound('This agent is not active yet.');
  const gigs = await c.env.DB.prepare(
    `SELECT g.*, ${PUBLIC_USER_COLS} FROM gigs g JOIN users u ON u.wallet = g.seller_wallet LEFT JOIN users o ON o.wallet = u.operator_wallet
     WHERE g.seller_wallet = ? AND g.status = 'active' ORDER BY g.created_at DESC LIMIT 50`,
  ).bind(u.wallet).all();
  const agents = u.kind === 'person'
    ? await c.env.DB.prepare("SELECT handle, display_name, human_review FROM users WHERE operator_wallet = ? AND kind = 'agent' AND operator_approved = 1 AND banned = 0 AND handle IS NOT NULL").bind(u.wallet).all()
    : { results: [] };
  return json({ user: publicProfile(u, op?.handle ?? null), gigs: gigs.results.map(gigFromRow), agents: agents.results });
};

// ---------- gigs ----------

function gigInput(b: Record<string, unknown>) {
  const image_key = b.image_key ? v.str(b.image_key, 'Image', 10, 80) : null;
  if (image_key && !/^[a-f0-9]{32}\.(png|jpg|webp)$/.test(image_key)) throw bad('Upload the image again.');
  return {
    title: v.str(b.title, 'Title', 10, 90),
    description: v.str(b.description, 'Description', 30, 4000),
    category: v.oneOf(b.category, 'Category', v.CATEGORIES),
    price_ltmx: v.int(b.price_ltmx, 'Price', 1, 100_000_000),
    delivery_days: v.int(b.delivery_days, 'Delivery time', 1, 90),
    image_key,
  };
}

const listGigs: Handler = async (c) => {
  const p = c.url.searchParams;
  const where = [`g.status = 'active'`, VISIBLE_USER];
  const args: unknown[] = [];
  const cat = p.get('category');
  if (cat && (v.CATEGORIES as readonly string[]).includes(cat)) { where.push('g.category = ?'); args.push(cat); }
  const q = (p.get('q') || '').trim().slice(0, 60);
  if (q) { where.push(`(g.title LIKE ? ESCAPE '\\' OR g.description LIKE ? ESCAPE '\\' OR u.handle LIKE ? ESCAPE '\\')`); args.push(likeTerm(q), likeTerm(q), likeTerm(q)); }
  const who = p.get('who');
  if (who === 'people') where.push(`u.kind = 'person'`);
  if (who === 'agents') where.push(`u.kind = 'agent'`);
  const order = { low: 'g.price_ltmx ASC', high: 'g.price_ltmx DESC' }[p.get('sort') || ''] || 'g.created_at DESC';
  const limit = Math.min(Number(p.get('limit')) || 24, 60);
  const offset = Math.max(Number(p.get('offset')) || 0, 0);
  const rows = await c.env.DB.prepare(
    `SELECT g.*, ${PUBLIC_USER_COLS} FROM gigs g JOIN users u ON u.wallet = g.seller_wallet LEFT JOIN users o ON o.wallet = u.operator_wallet
     WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`,
  ).bind(...args, limit, offset).all();
  return json({ gigs: rows.results.map(gigFromRow) });
};

const getGig: Handler = async (c) => {
  const gid = id(c.params[0]);
  const r = await c.env.DB.prepare(
    `SELECT g.*, ${PUBLIC_USER_COLS} FROM gigs g JOIN users u ON u.wallet = g.seller_wallet LEFT JOIN users o ON o.wallet = u.operator_wallet
     WHERE g.id = ? AND g.status != 'deleted'`,
  ).bind(gid).first<Record<string, unknown>>();
  if (!r) throw notFound('This service no longer exists.');
  const mine = c.user?.wallet === r.seller_wallet;
  if (r.status !== 'active' && !mine && !isAdmin(c.env, c.user)) throw notFound('This service is not available.');
  return json({ gig: gigFromRow(r), mine });
};

const createGig: Handler = async (c) => {
  const u = await requireActiveProfile(c);
  const g = gigInput(await readJson(c.request));
  await rateLimit(c.env, "SELECT COUNT(*) AS n FROM gigs WHERE seller_wallet = ? AND status IN ('active', 'paused')", [u.wallet], MAX_ACTIVE_GIGS,
    `You can have at most ${MAX_ACTIVE_GIGS} services. Delete one to add another.`);
  const t = now();
  const row = await c.env.DB.prepare(
    `INSERT INTO gigs (seller_wallet, title, description, category, price_ltmx, delivery_days, image_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(u.wallet, g.title, g.description, g.category, g.price_ltmx, g.delivery_days, g.image_key, t, t).first<{ id: number }>();
  return json({ id: row!.id }, 201);
};

const updateGig: Handler = async (c) => {
  const u = await requireActiveProfile(c);
  const gid = id(c.params[0]);
  const b = await readJson(c.request);
  const g = gigInput(b);
  const status = b.status === undefined ? 'active' : v.oneOf(b.status, 'Status', ['active', 'paused'] as const);
  const res = await c.env.DB.prepare(
    `UPDATE gigs SET title = ?, description = ?, category = ?, price_ltmx = ?, delivery_days = ?, image_key = ?, status = ?, updated_at = ?
     WHERE id = ? AND seller_wallet = ? AND status IN ('active', 'paused')`,
  ).bind(g.title, g.description, g.category, g.price_ltmx, g.delivery_days, g.image_key, status, now(), gid, u.wallet).run();
  if (!res.meta.changes) throw notFound('You can only edit your own active or paused services.');
  return json({ ok: true });
};

const deleteGig: Handler = async (c) => {
  const u = requireUser(c);
  const res = await c.env.DB.prepare("UPDATE gigs SET status = 'deleted', updated_at = ? WHERE id = ? AND seller_wallet = ? AND status != 'deleted'")
    .bind(now(), id(c.params[0]), u.wallet).run();
  if (!res.meta.changes) throw notFound();
  return json({ ok: true });
};

const myGigs: Handler = async (c) => {
  const u = requireUser(c);
  const rows = await c.env.DB.prepare(
    `SELECT g.*, ${PUBLIC_USER_COLS} FROM gigs g JOIN users u ON u.wallet = g.seller_wallet LEFT JOIN users o ON o.wallet = u.operator_wallet
     WHERE g.seller_wallet = ? AND g.status != 'deleted' ORDER BY g.created_at DESC`,
  ).bind(u.wallet).all();
  return json({ gigs: rows.results.map(gigFromRow) });
};

// ---------- projects and bids ----------

const PROJECT_SELECT = `SELECT p.*, (SELECT COUNT(*) FROM bids b WHERE b.project_id = p.id AND b.status != 'withdrawn') AS bid_count, ${PUBLIC_USER_COLS}
  FROM projects p JOIN users u ON u.wallet = p.client_wallet LEFT JOIN users o ON o.wallet = u.operator_wallet`;

const listProjects: Handler = async (c) => {
  const p = c.url.searchParams;
  const where = [`p.status = 'open'`, VISIBLE_USER];
  const args: unknown[] = [];
  const cat = p.get('category');
  if (cat && (v.CATEGORIES as readonly string[]).includes(cat)) { where.push('p.category = ?'); args.push(cat); }
  const q = (p.get('q') || '').trim().slice(0, 60);
  if (q) { where.push(`(p.title LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')`); args.push(likeTerm(q), likeTerm(q)); }
  const pol = p.get('policy');
  if (pol === 'agents') where.push('p.agent_policy IN (1, 2)');
  if (pol === 'people') where.push('p.agent_policy IN (0, 1)');
  const limit = Math.min(Number(p.get('limit')) || 30, 60);
  const offset = Math.max(Number(p.get('offset')) || 0, 0);
  const rows = await c.env.DB.prepare(`${PROJECT_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`)
    .bind(...args, limit, offset).all();
  return json({ projects: rows.results.map(projectFromRow) });
};

const getProject: Handler = async (c) => {
  const pid = id(c.params[0]);
  const r = await c.env.DB.prepare(`${PROJECT_SELECT} WHERE p.id = ?`).bind(pid).first<Record<string, unknown>>();
  if (!r) throw notFound('This project no longer exists.');
  const mine = c.user?.wallet === r.client_wallet;
  if (r.status === 'hidden' && !mine && !isAdmin(c.env, c.user)) throw notFound('This project is not available.');
  let bids: unknown[] = [];
  let my_bid: unknown = null;
  if (mine) {
    const rows = await c.env.DB.prepare(
      `SELECT b.id, b.price_ltmx, b.days, b.note, b.status, b.created_at, ${PUBLIC_USER_COLS}
       FROM bids b JOIN users u ON u.wallet = b.bidder_wallet LEFT JOIN users o ON o.wallet = u.operator_wallet
       WHERE b.project_id = ? AND b.status != 'withdrawn' ORDER BY b.created_at`,
    ).bind(pid).all();
    bids = rows.results.map((b) => ({ id: b.id, price_ltmx: b.price_ltmx, days: b.days, note: b.note, status: b.status, created_at: b.created_at, bidder: pickUser(b) }));
  } else if (c.user) {
    my_bid = await c.env.DB.prepare('SELECT id, price_ltmx, days, note, status FROM bids WHERE project_id = ? AND bidder_wallet = ?').bind(pid, c.user.wallet).first();
  }
  return json({ project: projectFromRow(r), mine, bids, my_bid });
};

const createProject: Handler = async (c) => {
  const u = await requireActiveProfile(c);
  const b = await readJson(c.request);
  const title = v.str(b.title, 'Title', 10, 120);
  const description = v.str(b.description, 'Description', 30, 6000);
  const category = v.oneOf(b.category, 'Category', v.CATEGORIES);
  const budget = v.int(b.budget_ltmx, 'Budget', 1, 1_000_000_000);
  const days = v.int(b.days, 'Deadline', 1, 365);
  const policy = v.int(b.agent_policy, 'Who can bid', 0, 2);
  const sk = v.skills(b.skills);
  await rateLimit(c.env, 'SELECT COUNT(*) AS n FROM projects WHERE client_wallet = ? AND created_at > ?', [u.wallet, now() - 86400], 10,
    'You can post at most 10 projects a day.');
  const row = await c.env.DB.prepare(
    `INSERT INTO projects (client_wallet, title, description, category, budget_ltmx, days, agent_policy, skills, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(u.wallet, title, description, category, budget, days, policy, JSON.stringify(sk), now()).first<{ id: number }>();
  return json({ id: row!.id }, 201);
};

const closeProject: Handler = async (c) => {
  const u = requireUser(c);
  const res = await c.env.DB.prepare("UPDATE projects SET status = 'closed' WHERE id = ? AND client_wallet = ? AND status IN ('open', 'awarded')")
    .bind(id(c.params[0]), u.wallet).run();
  if (!res.meta.changes) throw notFound();
  return json({ ok: true });
};

const myProjects: Handler = async (c) => {
  const u = requireUser(c);
  const rows = await c.env.DB.prepare(`${PROJECT_SELECT} WHERE p.client_wallet = ? AND p.status != 'hidden' ORDER BY p.created_at DESC`).bind(u.wallet).all();
  return json({ projects: rows.results.map(projectFromRow) });
};

const createBid: Handler = async (c) => {
  const u = await requireActiveProfile(c);
  const pid = id(c.params[0]);
  const b = await readJson(c.request);
  const price = v.int(b.price_ltmx, 'Your price', 1, 1_000_000_000);
  const days = v.int(b.days, 'Delivery time', 1, 365);
  const note = v.str(b.note, 'Cover note', 20, 3000);
  const p = await c.env.DB.prepare("SELECT client_wallet, agent_policy, status FROM projects WHERE id = ?").bind(pid)
    .first<{ client_wallet: string; agent_policy: number; status: string }>();
  if (!p || p.status !== 'open') throw notFound('This project is not taking bids.');
  if (p.client_wallet === u.wallet) throw bad("You can't bid on your own project.");
  if (u.kind === 'agent' && p.agent_policy === 0) throw forbidden('This project is for people only. AI agents cannot bid.');
  if (u.kind === 'person' && p.agent_policy === 2) throw forbidden('This project is for AI agents only.');
  await rateLimit(c.env, 'SELECT COUNT(*) AS n FROM bids WHERE bidder_wallet = ? AND created_at > ?', [u.wallet, now() - 3600], BIDS_PER_HOUR,
    'You have placed a lot of bids in the last hour. Try again later.');
  if (u.kind === 'agent') {
    await rateLimit(c.env,
      "SELECT COUNT(*) AS n FROM bids b JOIN users a ON a.wallet = b.bidder_wallet WHERE a.operator_wallet = ? AND a.kind = 'agent' AND b.created_at > ?",
      [u.operator_wallet, now() - 3600], OPERATOR_BIDS_PER_HOUR, "This operator's agents have placed too many bids in the last hour.");
  }
  try {
    const row = await c.env.DB.prepare('INSERT INTO bids (project_id, bidder_wallet, price_ltmx, days, note, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
      .bind(pid, u.wallet, price, days, note, now()).first<{ id: number }>();
    return json({ id: row!.id }, 201);
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw bad('You already bid on this project. Withdraw it first to bid again.');
    throw e;
  }
};

const setBidStatus = (action: 'accept' | 'reject' | 'withdraw'): Handler => async (c) => {
  const u = requireUser(c);
  const bid = await c.env.DB.prepare(
    'SELECT b.id, b.bidder_wallet, b.status, b.project_id, p.client_wallet, p.status AS p_status FROM bids b JOIN projects p ON p.id = b.project_id WHERE b.id = ?',
  ).bind(id(c.params[0])).first<{ id: number; bidder_wallet: string; status: string; project_id: number; client_wallet: string; p_status: string }>();
  if (!bid) throw notFound();
  if (action === 'withdraw') {
    if (bid.bidder_wallet !== u.wallet) throw notFound();
    if (bid.status !== 'pending') throw bad('Only pending bids can be withdrawn.');
    await c.env.DB.prepare("DELETE FROM bids WHERE id = ?").bind(bid.id).run();
    return json({ ok: true });
  }
  if (bid.client_wallet !== u.wallet) throw notFound();
  if (bid.status !== 'pending' || bid.p_status !== 'open') throw bad('This bid can no longer be changed.');
  if (action === 'accept') {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE bids SET status = 'accepted' WHERE id = ?").bind(bid.id),
      c.env.DB.prepare("UPDATE projects SET status = 'awarded' WHERE id = ?").bind(bid.project_id),
    ]);
  } else {
    await c.env.DB.prepare("UPDATE bids SET status = 'rejected' WHERE id = ?").bind(bid.id).run();
  }
  return json({ ok: true });
};

const myBids: Handler = async (c) => {
  const u = requireUser(c);
  const rows = await c.env.DB.prepare(
    `SELECT b.id, b.price_ltmx, b.days, b.status, b.created_at, p.id AS project_id, p.title AS project_title, p.status AS project_status
     FROM bids b JOIN projects p ON p.id = b.project_id WHERE b.bidder_wallet = ? ORDER BY b.created_at DESC LIMIT 100`,
  ).bind(u.wallet).all();
  return json({ bids: rows.results });
};

// ---------- instant hire ----------

const listHire: Handler = async (c) => {
  const p = c.url.searchParams;
  const where = ['u.available = 1', 'u.last_seen_at > ?', VISIBLE_USER];
  const args: unknown[] = [now() - HIRE_WINDOW];
  const who = p.get('who');
  if (who === 'people') where.push(`u.kind = 'person'`);
  if (who === 'agents') where.push(`u.kind = 'agent'`);
  const rows = await c.env.DB.prepare(
    `SELECT u.*, o.handle AS o_handle FROM users u LEFT JOIN users o ON o.wallet = u.operator_wallet
     WHERE ${where.join(' AND ')} ORDER BY u.last_seen_at DESC LIMIT 60`,
  ).bind(...args).all<User & { o_handle: string | null }>();
  return json({ people: rows.results.map((r) => publicProfile(r, r.o_handle)) });
};

// ---------- images ----------

const uploadImage: Handler = async (c) => {
  await requireActiveProfile(c);
  const len = Number(c.request.headers.get('content-length') || 0);
  if (len > MAX_IMAGE_BYTES + 10_000) throw bad('Images can be at most 2 MB.');
  const form = await c.request.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') throw bad('Choose an image to upload.');
  const ext = IMAGE_TYPES[file.type];
  if (!ext) throw bad('Use a PNG, JPG or WebP image.');
  if (file.size > MAX_IMAGE_BYTES) throw bad('Images can be at most 2 MB.');
  const key = `${crypto.randomUUID().replace(/-/g, '')}.${ext}`;
  await c.env.IMAGES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  return json({ key, url: `/api/images/${key}` }, 201);
};

const getImage: Handler = async (c) => {
  const key = c.params[0];
  if (!/^[a-f0-9]{32}\.(png|jpg|webp)$/.test(key)) throw notFound();
  const obj = await c.env.IMAGES.get(key);
  if (!obj) throw notFound();
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
};

// ---------- messages ----------

async function requireConversation(c: Ctx, cid: number) {
  const u = requireUser(c);
  const cv = await c.env.DB.prepare('SELECT * FROM conversations WHERE id = ? AND (a_wallet = ? OR b_wallet = ?)').bind(cid, u.wallet, u.wallet)
    .first<{ id: number; a_wallet: string; b_wallet: string }>();
  if (!cv) throw notFound('Conversation not found.');
  return { u, cv };
}

const openConversation: Handler = async (c) => {
  const u = await requireActiveProfile(c);
  const b = await readJson(c.request);
  const other = v.wallet(b.with, 'Recipient');
  if (other === u.wallet) throw bad("You can't message yourself.");
  const ctype = b.context_type === undefined ? 'direct' : v.oneOf(b.context_type, 'Context', ['gig', 'project', 'direct'] as const);
  const cid = ctype === 'direct' ? 0 : v.int(b.context_id, 'Context id', 1, Number.MAX_SAFE_INTEGER);
  const o = await c.env.DB.prepare('SELECT handle, banned FROM users WHERE wallet = ?').bind(other).first<{ handle: string | null; banned: number }>();
  if (!o || !o.handle || o.banned) throw notFound('That user is not available.');
  const [a, z] = [u.wallet, other].sort();
  const t = now();
  await c.env.DB.prepare(
    `INSERT INTO conversations (a_wallet, b_wallet, context_type, context_id, created_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (a_wallet, b_wallet, context_type, context_id) DO NOTHING`,
  ).bind(a, z, ctype, cid, t, t).run();
  const row = await c.env.DB.prepare('SELECT id FROM conversations WHERE a_wallet = ? AND b_wallet = ? AND context_type = ? AND context_id = ?')
    .bind(a, z, ctype, cid).first<{ id: number }>();
  return json({ id: row!.id });
};

const listConversations: Handler = async (c) => {
  const u = requireUser(c);
  const rows = await c.env.DB.prepare(
    `SELECT cv.id, cv.context_type, cv.context_id, cv.last_message_at,
       CASE WHEN cv.a_wallet = ?1 THEN cv.b_wallet ELSE cv.a_wallet END AS other_wallet,
       ou.handle AS other_handle, ou.display_name AS other_name, ou.kind AS other_kind,
       (SELECT body FROM messages m WHERE m.conversation_id = cv.id ORDER BY m.id DESC LIMIT 1) AS last_body,
       (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = cv.id AND m.sender_wallet != ?1
          AND m.id > COALESCE((SELECT last_read_id FROM conversation_reads r WHERE r.conversation_id = cv.id AND r.wallet = ?1), 0)) AS unread,
       CASE cv.context_type WHEN 'gig' THEN (SELECT title FROM gigs WHERE id = cv.context_id)
                            WHEN 'project' THEN (SELECT title FROM projects WHERE id = cv.context_id) END AS context_title
     FROM conversations cv JOIN users ou ON ou.wallet = CASE WHEN cv.a_wallet = ?1 THEN cv.b_wallet ELSE cv.a_wallet END
     WHERE cv.a_wallet = ?1 OR cv.b_wallet = ?1 ORDER BY cv.last_message_at DESC LIMIT 100`,
  ).bind(u.wallet).all();
  return json({ conversations: rows.results });
};

const listMessages: Handler = async (c) => {
  const { u, cv } = await requireConversation(c, id(c.params[0]));
  const after = Math.max(Number(c.url.searchParams.get('after')) || 0, 0);
  const rows = await c.env.DB.prepare('SELECT id, sender_wallet, body, created_at FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id LIMIT 200')
    .bind(cv.id, after).all<{ id: number }>();
  const last = rows.results.at(-1)?.id;
  if (last) {
    await c.env.DB.prepare(
      `INSERT INTO conversation_reads (conversation_id, wallet, last_read_id) VALUES (?, ?, ?)
       ON CONFLICT (conversation_id, wallet) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`,
    ).bind(cv.id, u.wallet, last).run();
  }
  return json({ messages: rows.results });
};

const sendMessage: Handler = async (c) => {
  await requireActiveProfile(c);
  const { u, cv } = await requireConversation(c, id(c.params[0]));
  const body = v.str((await readJson(c.request)).body, 'Message', 1, 4000);
  await rateLimit(c.env, 'SELECT COUNT(*) AS n FROM messages WHERE sender_wallet = ? AND created_at > ?', [u.wallet, now() - 3600], MESSAGES_PER_HOUR,
    'You have sent a lot of messages in the last hour. Try again later.');
  const t = now();
  const row = await c.env.DB.prepare('INSERT INTO messages (conversation_id, sender_wallet, body, created_at) VALUES (?, ?, ?, ?) RETURNING id')
    .bind(cv.id, u.wallet, body, t).first<{ id: number }>();
  await c.env.DB.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').bind(t, cv.id).run();
  return json({ id: row!.id, created_at: t }, 201);
};

// ---------- reports and admin ----------

const createReport: Handler = async (c) => {
  const u = requireUser(c);
  const b = await readJson(c.request);
  const target_type = v.oneOf(b.target_type, 'What you are reporting', ['gig', 'project', 'user', 'message'] as const);
  const target_id = v.str(String(b.target_id ?? ''), 'Target', 1, 64);
  const reason = v.str(b.reason, 'Reason', 5, 1000);
  await rateLimit(c.env, 'SELECT COUNT(*) AS n FROM reports WHERE reporter_wallet = ? AND created_at > ?', [u.wallet, now() - 86400], 20,
    'You have sent a lot of reports today. Our team will review them.');
  await c.env.DB.prepare('INSERT INTO reports (reporter_wallet, target_type, target_id, reason, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(u.wallet, target_type, target_id, reason, now()).run();
  return json({ ok: true }, 201);
};

const adminReports: Handler = async (c) => {
  requireAdmin(c);
  const status = c.url.searchParams.get('status') === 'resolved' ? 'resolved' : 'open';
  const rows = await c.env.DB.prepare(
    `SELECT r.*, u.handle AS reporter_handle FROM reports r LEFT JOIN users u ON u.wallet = r.reporter_wallet WHERE r.status = ? ORDER BY r.created_at DESC LIMIT 200`,
  ).bind(status).all();
  return json({ reports: rows.results });
};

const adminResolve: Handler = async (c) => {
  requireAdmin(c);
  await c.env.DB.prepare("UPDATE reports SET status = 'resolved' WHERE id = ?").bind(id(c.params[0])).run();
  return json({ ok: true });
};

const adminHide: Handler = async (c) => {
  requireAdmin(c);
  const b = await readJson(c.request);
  const type = v.oneOf(b.type, 'Type', ['gig', 'project', 'message'] as const);
  const tid = v.int(b.id, 'Id', 1, Number.MAX_SAFE_INTEGER);
  const hide = b.hidden !== false;
  if (type === 'gig') await c.env.DB.prepare('UPDATE gigs SET status = ? WHERE id = ?').bind(hide ? 'hidden' : 'active', tid).run();
  if (type === 'project') await c.env.DB.prepare('UPDATE projects SET status = ? WHERE id = ?').bind(hide ? 'hidden' : 'open', tid).run();
  if (type === 'message') await c.env.DB.prepare("UPDATE messages SET body = '[removed by moderator]' WHERE id = ?").bind(tid).run();
  return json({ ok: true });
};

const adminBan: Handler = async (c) => {
  const admin = requireAdmin(c);
  const target = v.wallet(c.params[0]);
  if (target === admin.wallet) throw bad("You can't ban yourself.");
  const banned = (await readJson(c.request)).banned !== false;
  await c.env.DB.prepare('UPDATE users SET banned = ? WHERE wallet = ?').bind(banned ? 1 : 0, target).run();
  if (banned) await c.env.DB.prepare('DELETE FROM sessions WHERE wallet = ?').bind(target).run();
  return json({ ok: true });
};

// ---------- router ----------

const routes: [string, RegExp, Handler][] = [
  ['POST', /^\/api\/auth\/nonce$/, authNonce],
  ['POST', /^\/api\/auth\/verify$/, authVerify],
  ['POST', /^\/api\/auth\/logout$/, authLogout],
  ['GET', /^\/api\/me$/, getMe],
  ['PUT', /^\/api\/me$/, putMe],
  ['GET', /^\/api\/me\/gigs$/, myGigs],
  ['GET', /^\/api\/me\/projects$/, myProjects],
  ['GET', /^\/api\/me\/bids$/, myBids],
  ['POST', /^\/api\/agents\/([^/]+)\/approve$/, setAgentApproval(true)],
  ['POST', /^\/api\/agents\/([^/]+)\/revoke$/, setAgentApproval(false)],
  ['GET', /^\/api\/users\/([^/]+)$/, getUser],
  ['GET', /^\/api\/gigs$/, listGigs],
  ['POST', /^\/api\/gigs$/, createGig],
  ['GET', /^\/api\/gigs\/(\d+)$/, getGig],
  ['PUT', /^\/api\/gigs\/(\d+)$/, updateGig],
  ['DELETE', /^\/api\/gigs\/(\d+)$/, deleteGig],
  ['GET', /^\/api\/projects$/, listProjects],
  ['POST', /^\/api\/projects$/, createProject],
  ['GET', /^\/api\/projects\/(\d+)$/, getProject],
  ['POST', /^\/api\/projects\/(\d+)\/close$/, closeProject],
  ['POST', /^\/api\/projects\/(\d+)\/bids$/, createBid],
  ['POST', /^\/api\/bids\/(\d+)\/accept$/, setBidStatus('accept')],
  ['POST', /^\/api\/bids\/(\d+)\/reject$/, setBidStatus('reject')],
  ['POST', /^\/api\/bids\/(\d+)\/withdraw$/, setBidStatus('withdraw')],
  ['GET', /^\/api\/hire$/, listHire],
  ['POST', /^\/api\/uploads$/, uploadImage],
  ['GET', /^\/api\/images\/([^/]+)$/, getImage],
  ['POST', /^\/api\/conversations$/, openConversation],
  ['GET', /^\/api\/conversations$/, listConversations],
  ['GET', /^\/api\/conversations\/(\d+)\/messages$/, listMessages],
  ['POST', /^\/api\/conversations\/(\d+)\/messages$/, sendMessage],
  ['POST', /^\/api\/reports$/, createReport],
  ['GET', /^\/api\/admin\/reports$/, adminReports],
  ['POST', /^\/api\/admin\/reports\/(\d+)\/resolve$/, adminResolve],
  ['POST', /^\/api\/admin\/hide$/, adminHide],
  ['POST', /^\/api\/admin\/users\/([^/]+)\/ban$/, adminBan],
];

export async function handle(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    let pathMatched = false;
    for (const [m, re, h] of routes) {
      const match = url.pathname.match(re);
      if (!match) continue;
      pathMatched = true;
      if (m !== method) continue;
      if (method !== 'GET') requireAppHeader(request);
      const user = await currentUser(env, request);
      return await h({ env, request, url, params: match.slice(1), user });
    }
    if (pathMatched) return json({ error: 'Method not allowed.' }, 405);
    throw notFound('Unknown API endpoint.');
  } catch (err) {
    return errorResponse(err);
  }
}
