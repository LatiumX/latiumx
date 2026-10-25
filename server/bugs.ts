// Bug reports. Any logged-in wallet can send one; admins see the reporter's wallet so they can
// send a reward.
import type { Env, User } from './env';
import { HttpError, notFound, now } from './http';
import * as v from './validate';

export const BUG_STATUSES = ['new', 'confirmed', 'rewarded', 'rejected'] as const;

let tableReady = false;

/** Creates the table on first use, so the live database doesn't need a manual migration. */
async function ensureTable(env: Env) {
  if (tableReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS bug_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_wallet TEXT NOT NULL,
      title TEXT NOT NULL,
      details TEXT NOT NULL,
      page TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'confirmed', 'rewarded', 'rejected')),
      admin_note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS bug_reports_status ON bug_reports (status, created_at DESC)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS bug_reports_reporter ON bug_reports (reporter_wallet, created_at DESC)'),
  ]);
  tableReady = true;
}

export async function createBugReport(env: Env, u: User, b: Record<string, unknown>, userAgent: string) {
  await ensureTable(env);
  const title = v.str(b.title, 'Short summary', 5, 140);
  const details = v.str(b.details, 'What happened', 10, 5000);
  const page = v.optStr(b.page, 'Page', 300);
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM bug_reports WHERE reporter_wallet = ? AND created_at > ?')
    .bind(u.wallet, now() - 86400)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= 10) throw new HttpError(429, 'You have sent 10 bug reports today. Thanks! Please send more tomorrow.');
  const t = now();
  const row = await env.DB.prepare(
    'INSERT INTO bug_reports (reporter_wallet, title, details, page, user_agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
  )
    .bind(u.wallet, title, details, page, userAgent.slice(0, 300), t, t)
    .first<{ id: number }>();
  return row!.id;
}

export async function myBugReports(env: Env, u: User) {
  await ensureTable(env);
  const rows = await env.DB.prepare('SELECT id, title, status, admin_note, created_at FROM bug_reports WHERE reporter_wallet = ? ORDER BY created_at DESC LIMIT 50')
    .bind(u.wallet)
    .all();
  return rows.results;
}

export async function listBugReports(env: Env, status: string) {
  await ensureTable(env);
  const s = status === 'all' ? null : v.oneOf(status, 'Status', BUG_STATUSES);
  const rows = await env.DB.prepare(
    `SELECT b.*, u.handle AS reporter_handle,
       (SELECT COUNT(*) FROM bug_reports x WHERE x.reporter_wallet = b.reporter_wallet AND x.status = 'rewarded' AND x.id != b.id) AS reporter_rewarded
     FROM bug_reports b LEFT JOIN users u ON u.wallet = b.reporter_wallet
     ${s ? 'WHERE b.status = ?' : ''} ORDER BY b.created_at DESC LIMIT 200`,
  )
    .bind(...(s ? [s] : []))
    .all();
  return rows.results;
}

export async function updateBugReport(env: Env, id: number, b: Record<string, unknown>) {
  await ensureTable(env);
  const status = v.oneOf(b.status, 'Status', BUG_STATUSES);
  const note = v.optStr(b.admin_note, 'Note', 500);
  const res = await env.DB.prepare('UPDATE bug_reports SET status = ?, admin_note = ?, updated_at = ? WHERE id = ?').bind(status, note, now(), id).run();
  if (!res.meta.changes) throw notFound('That bug report does not exist.');
}
