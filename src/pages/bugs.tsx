import { useState, type FormEvent } from 'react';
import { api, ago, shortWallet } from '../api';
import { useAuth } from '../auth';
import { Empty, ErrorNote, useLoad } from '../ui';

type MyBug = { id: number; title: string; status: string; admin_note: string; created_at: number };
type Bug = MyBug & {
  reporter_wallet: string;
  reporter_handle: string | null;
  reporter_rewarded: number;
  details: string;
  page: string;
  user_agent: string;
};

const STATUS_LABEL: Record<string, string> = { new: 'New', confirmed: 'Confirmed', rewarded: 'Rewarded', rejected: 'Not a bug' };

// The page the person was on when they pressed "Report a bug".
let reportedFrom = '';
export const rememberPage = () => {
  if (!location.hash.startsWith('#/bug')) reportedFrom = location.hash || '#/';
};

export function ReportBug() {
  const { me, loading, login, signingIn } = useAuth();
  const [form, setForm] = useState({ title: '', details: '', page: reportedFrom });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const mine = useLoad(() => (me?.user ? api<{ bugs: MyBug[] }>('/api/me/bugs') : Promise.resolve({ bugs: [] })), [me?.user?.wallet, sent]);
  if (loading) return <p className="loading page">Loading…</p>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api('/api/bugs', { body: form });
      setSent(true);
      setForm({ title: '', details: '', page: '' });
    } catch (er: any) {
      setErr(er.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page bug-page">
      <div className="page-head">
        <div>
          <h1>Report a bug</h1>
          <p>Found something broken? Tell us. Useful reports can earn a reward, sent to the wallet you're logged in with.</p>
        </div>
      </div>

      {!me?.user ? (
        <div className="panel">
          <p>Log in with your wallet first, so we know where to send a reward.</p>
          <button className="btn" type="button" onClick={login} disabled={signingIn} style={{ marginTop: 12 }}>
            {signingIn ? 'Check your wallet…' : 'Connect wallet'}
          </button>
        </div>
      ) : (
        <div className="panel">
          {sent && <p className="okmsg" role="status">Thanks! Your report was sent. You can follow it below.</p>}
          <form className="form" onSubmit={submit}>
            <label className="field">Short summary
              <input id="bug-title" required minLength={5} maxLength={140} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Save button does nothing on my profile" />
            </label>
            <label className="field">What happened?
              <textarea id="bug-details" required minLength={10} maxLength={5000} rows={7} value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })}
                placeholder={'1. What you did\n2. What you expected\n3. What happened instead\nYour device and browser help too.'} />
            </label>
            <label className="field">Page (optional)
              <input id="bug-page" maxLength={300} value={form.page} onChange={(e) => setForm({ ...form, page: e.target.value })} placeholder="e.g. #/dashboard" />
            </label>
            <p className="muted">
              Reward wallet: <code className="wallet-full">{me.user.wallet}</code>. Never send your recovery phrase or private key to anyone, including us.
            </p>
            <ErrorNote error={err} />
            <button className="btn" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send report'}</button>
          </form>
        </div>
      )}

      {!!mine.data?.bugs.length && (
        <div className="section" style={{ paddingTop: 24 }}>
          <h2>Your reports</h2>
          <div className="list">
            {mine.data.bugs.map((b) => (
              <div className="item" key={b.id}>
                <div style={{ display: 'grid', gap: 4, flex: '1 1 260px' }}>
                  <b>{b.title}</b>
                  <span className="muted">Sent {ago(b.created_at)}{b.admin_note ? ` · ${b.admin_note}` : ''}</span>
                </div>
                <span className={`status${b.status === 'rewarded' || b.status === 'confirmed' ? ' good' : ''}`}>{STATUS_LABEL[b.status] || b.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function AdminBugs() {
  const [status, setStatus] = useState('new');
  const { data, error, reload } = useLoad(() => api<{ bugs: Bug[] }>(`/api/admin/bugs?status=${status}`), [status]);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [copied, setCopied] = useState<number | null>(null);

  const set = async (b: Bug, next: string) => {
    setMsg({});
    try {
      await api(`/api/admin/bugs/${b.id}`, { body: { status: next, admin_note: notes[b.id] ?? b.admin_note } });
      setMsg({ ok: `Report #${b.id} marked ${STATUS_LABEL[next].toLowerCase()}.` });
      reload();
    } catch (e: any) {
      setMsg({ err: e.message });
    }
  };
  const copy = async (b: Bug) => {
    try {
      await navigator.clipboard.writeText(b.reporter_wallet);
      setCopied(b.id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setMsg({ err: 'Could not copy. Select the wallet address and copy it by hand.' });
    }
  };

  return (
    <div className="section" style={{ paddingTop: 12 }}>
      <h2>Bug reports</h2>
      <p className="muted">Send rewards to the reporter's wallet yourself, then mark the report rewarded with a note such as the amount or transaction link. The reporter sees the status and note.</p>
      <div className="tabsbar">
        {['new', 'confirmed', 'rewarded', 'rejected', 'all'].map((s) => (
          <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>{s === 'all' ? 'All' : STATUS_LABEL[s]}</button>
        ))}
      </div>
      <ErrorNote error={error || msg.err} />
      {msg.ok && <p className="okmsg">{msg.ok}</p>}
      {data?.bugs.length ? (
        <div className="list">
          {data.bugs.map((b) => (
            <div className="item bug" key={b.id} data-bug={b.id} style={{ alignItems: 'flex-start' }}>
              <div style={{ display: 'grid', gap: 6, flex: '1 1 340px', minWidth: 0 }}>
                <b>#{b.id} {b.title}</b>
                <p className="prose" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{b.details}</p>
                {b.page && <span className="muted">Page: {b.page.startsWith('#/') ? <a href={b.page}>{b.page}</a> : b.page}</span>}
                <span className="muted">
                  From {b.reporter_handle ? <a href={`#/u/${b.reporter_handle}`}>@{b.reporter_handle}</a> : shortWallet(b.reporter_wallet)} · {ago(b.created_at)}
                  {b.reporter_rewarded > 0 && ` · rewarded ${b.reporter_rewarded} time${b.reporter_rewarded === 1 ? '' : 's'} before`}
                </span>
                <div className="wallet-row">
                  <code className="wallet-full">{b.reporter_wallet}</code>
                  <button className="btn ghost sm" type="button" onClick={() => copy(b)}>{copied === b.id ? 'Copied' : 'Copy wallet'}</button>
                  <a className="muted" href={`https://solscan.io/account/${b.reporter_wallet}`} target="_blank" rel="noreferrer">Solscan</a>
                </div>
                {b.user_agent && <span className="muted small">{b.user_agent}</span>}
                <label className="field">Note for the reporter
                  <input value={notes[b.id] ?? b.admin_note} maxLength={500} onChange={(e) => setNotes({ ...notes, [b.id]: e.target.value })} placeholder="e.g. Sent 500 LTMX, thanks!" />
                </label>
              </div>
              <div className="actions" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <span className={`status${b.status === 'rewarded' ? ' good' : ''}`} style={{ alignSelf: 'flex-start' }}>{STATUS_LABEL[b.status]}</span>
                {b.status !== 'confirmed' && <button className="btn ghost sm" type="button" onClick={() => set(b, 'confirmed')}>Confirm bug</button>}
                {b.status !== 'rewarded' && <button className="btn sm" type="button" onClick={() => set(b, 'rewarded')}>Mark rewarded</button>}
                {b.status !== 'rejected' && <button className="linkbtn" type="button" onClick={() => set(b, 'rejected')}>Not a bug</button>}
              </div>
            </div>
          ))}
        </div>
      ) : <Empty>No {status === 'all' ? '' : STATUS_LABEL[status].toLowerCase() + ' '}bug reports.</Empty>}
    </div>
  );
}
