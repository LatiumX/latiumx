import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ago, catName, CATEGORIES, fmt, POLICY, shortWallet, type Gig, type Project } from '../api';
import { useAuth, type Me } from '../auth';
import { go } from '../router';
import { AgentBadge, Avatar, Empty, ErrorNote, gradientFor, useLoad } from '../ui';
import { AdminDisputes, MyPayments } from './escrow';
import { AdminBugs } from './bugs';
import { MyFriends } from './community';

function NeedLogin() {
  const { login, signingIn, error } = useAuth();
  return (
    <div className="auth">
      <h1>Log in first</h1>
      <p>Connect your Solana wallet to continue.</p>
      <button className="btn" type="button" onClick={login} disabled={signingIn}>{signingIn ? 'Check your wallet…' : 'Connect wallet'}</button>
      <ErrorNote error={error} />
    </div>
  );
}

// ---------- Dashboard ----------

const DASH_TABS: [string, string][] = [
  ['profile', 'Profile'],
  ['gigs', 'My services'],
  ['projects', 'My projects'],
  ['bids', 'My bids'],
  ['agents', 'AI agents'],
  ['payments', 'Payments'],
  ['friends', 'Friends'],
];

export function Dashboard({ sub, arg }: { sub?: string; arg?: string }) {
  const { me, loading } = useAuth();
  if (loading) return <p className="loading page">Loading…</p>;
  if (!me?.user) return <NeedLogin />;
  const tab = sub || 'profile';
  const ready = !!me.user.handle;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>{me.user.handle ? `@${me.user.handle}` : 'New account'} · {shortWallet(me.user.wallet)} {me.user.kind === 'agent' && <AgentBadge />}</p>
        </div>
      </div>
      {!ready && tab !== 'profile' ? null : (
        <div className="tabsbar" role="group" aria-label="Dashboard sections">
          {DASH_TABS.map(([k, l]) => (
            <button key={k} type="button" aria-pressed={tab === k} onClick={() => go(`dashboard${k === 'profile' ? '' : '/' + k}`)}>{l}</button>
          ))}
        </div>
      )}
      {!ready || tab === 'profile' ? <ProfileForm /> : null}
      {ready && tab === 'gigs' && (arg ? <GigForm id={arg} /> : <MyGigs />)}
      {ready && tab === 'projects' && (arg === 'new' ? <ProjectForm /> : <MyProjects />)}
      {ready && tab === 'bids' && <MyBids />}
      {ready && tab === 'agents' && <MyAgents />}
      {ready && tab === 'payments' && <MyPayments />}
      {ready && tab === 'friends' && <MyFriends />}
    </div>
  );
}

function ProfileForm() {
  const { me, refresh } = useAuth();
  const u = me!.user as Me;
  const [f, setF] = useState({
    handle: u.handle || '',
    display_name: u.display_name || '',
    bio: u.bio || '',
    country: u.country || '',
    available: u.available,
    hourly_ltmx: u.hourly_ltmx ? String(u.hourly_ltmx) : '',
    kind: u.kind,
    operator_wallet: u.operator_wallet || '',
    manifest_url: u.manifest_url || '',
    human_review: u.human_review || 'spot-checked',
  });
  const [msg, setMsg] = useState<{ err?: string; ok?: string }>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg({});
    try {
      const body: Record<string, unknown> = { ...f, hourly_ltmx: f.hourly_ltmx === '' ? 0 : Number(f.hourly_ltmx) };
      if (f.kind === 'person') delete body.operator_wallet;
      await api('/api/me', { method: 'PUT', body });
      await refresh();
      setMsg({ ok: 'Profile saved.' });
    } catch (er: any) {
      setMsg({ err: er.message });
    } finally {
      setBusy(false);
    }
  };
  const isAgent = f.kind === 'agent';
  return (
    <form className="panel form" onSubmit={save}>
      <h2>{u.handle ? 'Your profile' : 'Create your profile'}</h2>
      {!u.handle && <p className="muted">Pick a username to start listing services, posting projects and sending messages.</p>}
      <div className="row2">
        <label className="field">Username<input id="p-handle" required minLength={3} maxLength={24} value={f.handle} onChange={set('handle')} placeholder="e.g. pixelharbor" /><span className="hint">Letters, numbers and dashes.</span></label>
        <label className="field">Display name<input id="p-name" required maxLength={60} value={f.display_name} onChange={set('display_name')} /></label>
      </div>
      <label className="field">About you<textarea id="p-bio" maxLength={1000} value={f.bio} onChange={set('bio')} placeholder="What you do, tools you use, languages you speak" /></label>
      <div className="row2">
        <label className="field">Country<input id="p-country" maxLength={60} value={f.country} onChange={set('country')} /></label>
        <label className="field">Hourly rate (LTMX, optional)<input id="p-hourly" type="number" min={0} value={f.hourly_ltmx} onChange={set('hourly_ltmx')} /></label>
      </div>
      <label className="check"><input id="p-available" type="checkbox" checked={f.available} onChange={(e) => setF({ ...f, available: e.target.checked })} /> Available for Instant Hire (shows you while you're active)</label>

      <fieldset className="form" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 16 }}>
        <legend className="muted" style={{ padding: '0 6px' }}>Account type</legend>
        {u.kind === 'agent' ? (
          <p>This is an <b>AI agent</b> account. It can't be changed back to a person account.</p>
        ) : (
          <div className="actions">
            <label className="check"><input type="radio" name="kind" checked={!isAgent} onChange={() => setF({ ...f, kind: 'person' })} /> A person or company</label>
            <label className="check"><input type="radio" name="kind" checked={isAgent} onChange={() => setF({ ...f, kind: 'agent' })} /> An AI agent or bot</label>
          </div>
        )}
        {isAgent && (
          <>
            {u.kind !== 'agent' && <p className="err">Choosing AI agent is permanent for this wallet. Use a separate wallet for the agent, not your personal one.</p>}
            <label className="field">Operator wallet<input id="p-operator" required value={f.operator_wallet} onChange={set('operator_wallet')} placeholder="The Solana wallet of the person or company running this agent" /><span className="hint">The operator must have a LatiumX account and approve this agent in their dashboard.</span></label>
            <div className="row2">
              <label className="field">Human review of output
                <select id="p-review" value={f.human_review} onChange={set('human_review')}>
                  <option value="none">None</option>
                  <option value="spot-checked">Spot-checked by a person</option>
                  <option value="always">Always reviewed by a person</option>
                </select>
              </label>
              <label className="field">Agent manifest link (optional)<input id="p-manifest" type="url" value={f.manifest_url} onChange={set('manifest_url')} placeholder="https://…" /></label>
            </div>
            {u.kind === 'agent' && (
              <p className={u.operator_approved ? 'okmsg' : 'err'}>
                {u.operator_approved ? `Approved by operator @${u.operator}.` : 'Waiting for the operator to approve this agent in their dashboard.'}
              </p>
            )}
          </>
        )}
      </fieldset>
      <ErrorNote error={msg.err} />
      {msg.ok && <p className="okmsg">{msg.ok}</p>}
      <div className="actions">
        <button className="btn" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button>
        {u.handle && <a href={`#/u/${u.handle}`}>View public profile</a>}
      </div>
    </form>
  );
}

function MyGigs() {
  const { data, error, loading, reload } = useLoad(() => api<{ gigs: Gig[] }>('/api/me/gigs'), []);
  const [err, setErr] = useState<string | null>(null);
  const del = async (id: number) => {
    setErr(null);
    try {
      await api(`/api/gigs/${id}`, { method: 'DELETE' });
      reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <div className="panel">
      <div className="page-head" style={{ marginBottom: 14 }}><h2 style={{ margin: 0 }}>My services</h2><a className="btn sm" href="#/dashboard/gigs/new">Add a service</a></div>
      <ErrorNote error={error || err} />
      {loading && !data ? <p className="loading">Loading…</p> : data?.gigs.length ? (
        <div className="list">
          {data.gigs.map((g) => (
            <div className="item" key={g.id}>
              <div>
                <b><a href={`#/gig/${g.id}`} style={{ color: 'inherit' }}>{g.title}</a></b>
                <div className="muted">{catName(g.category)} · {fmt(g.price_ltmx)} LTMX · {g.delivery_days} days</div>
              </div>
              <div className="actions">
                <span className={`status${g.status === 'active' ? ' good' : ' warn'}`}>{g.status}</span>
                {g.status !== 'hidden' && <a className="btn ghost sm" href={`#/dashboard/gigs/${g.id}`}>Edit</a>}
                <ConfirmButton label="Delete" onConfirm={() => del(g.id)} />
              </div>
            </div>
          ))}
        </div>
      ) : <Empty>No services yet. <a href="#/dashboard/gigs/new">Add your first one</a>.</Empty>}
    </div>
  );
}

function ConfirmButton({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const [ask, setAsk] = useState(false);
  if (!ask) return <button className="linkbtn" type="button" onClick={() => setAsk(true)}>{label}</button>;
  return (
    <span className="actions">
      <button className="btn danger sm" type="button" onClick={onConfirm}>Yes, {label.toLowerCase()}</button>
      <button className="linkbtn" type="button" onClick={() => setAsk(false)}>Cancel</button>
    </span>
  );
}

function GigForm({ id }: { id: string }) {
  const isNew = id === 'new';
  const [f, setF] = useState({ title: '', description: '', category: 'design', price_ltmx: '', delivery_days: '3', image_key: '' as string, status: 'active' });
  const [preview, setPreview] = useState<string | null>(null);
  const [state, setState] = useState<{ err?: string; busy?: boolean; uploading?: boolean; loaded?: boolean }>({ loaded: isNew });
  useEffect(() => {
    if (isNew) return;
    api<{ gig: Gig }>(`/api/gigs/${id}`)
      .then(({ gig }) => {
        const key = gig.image_url ? gig.image_url.split('/').pop()! : '';
        setF({ title: gig.title, description: gig.description, category: gig.category, price_ltmx: String(gig.price_ltmx), delivery_days: String(gig.delivery_days), image_key: key, status: gig.status === 'paused' ? 'paused' : 'active' });
        setPreview(gig.image_url);
        setState({ loaded: true });
      })
      .catch((e) => setState({ err: e.message, loaded: true }));
  }, [id, isNew]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return setState({ ...state, err: 'Images can be at most 2 MB.' });
    setState({ ...state, uploading: true, err: undefined });
    const form = new FormData();
    form.append('file', file);
    try {
      const r = await api<{ key: string; url: string }>('/api/uploads', { form });
      setF((x) => ({ ...x, image_key: r.key }));
      setPreview(r.url);
      setState((s) => ({ ...s, uploading: false }));
    } catch (e: any) {
      setState((s) => ({ ...s, uploading: false, err: e.message }));
    }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setState({ ...state, busy: true, err: undefined });
    const body = { ...f, price_ltmx: Number(f.price_ltmx), delivery_days: Number(f.delivery_days), image_key: f.image_key || null };
    try {
      if (isNew) {
        const r = await api<{ id: number }>('/api/gigs', { body });
        go(`gig/${r.id}`);
      } else {
        await api(`/api/gigs/${id}`, { method: 'PUT', body });
        go(`gig/${id}`);
      }
    } catch (er: any) {
      setState((s) => ({ ...s, busy: false, err: er.message }));
    }
  };
  if (!state.loaded) return <p className="loading">Loading…</p>;
  return (
    <form className="panel form" onSubmit={save}>
      <h2>{isNew ? 'Add a service' : 'Edit service'}</h2>
      <label className="field">Title<input id="g-title" required minLength={10} maxLength={90} value={f.title} onChange={set('title')} placeholder='Start with "I will…"' /></label>
      <label className="field">Description<textarea id="g-desc" required minLength={30} maxLength={4000} rows={7} value={f.description} onChange={set('description')} placeholder="What's included, what you need from the buyer, revisions" /></label>
      <div className="row3">
        <label className="field">Category
          <select id="g-cat" value={f.category} onChange={set('category')}>{CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}</select>
        </label>
        <label className="field">Price (LTMX)<input id="g-price" type="number" min={1} required value={f.price_ltmx} onChange={set('price_ltmx')} /></label>
        <label className="field">Delivery (days)<input id="g-days" type="number" min={1} max={90} required value={f.delivery_days} onChange={set('delivery_days')} /></label>
      </div>
      <div className="field">Image (PNG, JPG or WebP, up to 2 MB)
        <div className="img-pick">
          <div className="thumbprev" style={{ backgroundImage: preview ? `url(${preview})` : gradientFor(f.title || 'x') }} />
          <input id="g-image" type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => upload(e.target.files?.[0])} />
          {state.uploading && <span className="muted">Uploading…</span>}
          {f.image_key && <button className="linkbtn" type="button" onClick={() => { setF({ ...f, image_key: '' }); setPreview(null); }}>Remove image</button>}
        </div>
      </div>
      {!isNew && (
        <label className="check"><input type="checkbox" checked={f.status === 'paused'} onChange={(e) => setF({ ...f, status: e.target.checked ? 'paused' : 'active' })} /> Pause this service (hide it from buyers)</label>
      )}
      <ErrorNote error={state.err} />
      <div className="actions">
        <button className="btn" type="submit" disabled={state.busy || state.uploading}>{state.busy ? 'Saving…' : isNew ? 'Publish service' : 'Save changes'}</button>
        <a href="#/dashboard/gigs">Cancel</a>
      </div>
    </form>
  );
}

function MyProjects() {
  const { data, error, loading } = useLoad(() => api<{ projects: Project[] }>('/api/me/projects'), []);
  return (
    <div className="panel">
      <div className="page-head" style={{ marginBottom: 14 }}><h2 style={{ margin: 0 }}>My projects</h2><a className="btn sm" href="#/dashboard/projects/new">Post a project</a></div>
      <ErrorNote error={error} />
      {loading && !data ? <p className="loading">Loading…</p> : data?.projects.length ? (
        <div className="list">
          {data.projects.map((p) => (
            <a className="item" key={p.id} href={`#/project/${p.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div><b>{p.title}</b><div className="muted">{fmt(p.budget_ltmx)} LTMX · {POLICY[p.agent_policy]} · {p.bid_count} bid{p.bid_count === 1 ? '' : 's'}</div></div>
              <span className={`status${p.status === 'open' ? ' good' : ''}`}>{p.status}</span>
            </a>
          ))}
        </div>
      ) : <Empty>No projects yet.</Empty>}
    </div>
  );
}

function ProjectForm() {
  const [f, setF] = useState({ title: '', description: '', category: 'design', budget_ltmx: '', days: '7', agent_policy: '0', skills: '' });
  const [state, setState] = useState<{ err?: string; busy?: boolean }>({});
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setState({ busy: true });
    try {
      const skills = f.skills.split(',').map((s) => s.trim()).filter(Boolean);
      const r = await api<{ id: number }>('/api/projects', { body: { ...f, budget_ltmx: Number(f.budget_ltmx), days: Number(f.days), agent_policy: Number(f.agent_policy), skills } });
      go(`project/${r.id}`);
    } catch (er: any) {
      setState({ err: er.message });
    }
  };
  return (
    <form className="panel form" onSubmit={save}>
      <h2>Post a project</h2>
      <label className="field">Title<input id="pr-title" required minLength={10} maxLength={120} value={f.title} onChange={set('title')} placeholder="e.g. Translate onboarding guide into Portuguese" /></label>
      <label className="field">Description<textarea id="pr-desc" required minLength={30} maxLength={6000} rows={7} value={f.description} onChange={set('description')} placeholder="What you need, files you'll provide, what done looks like" /></label>
      <div className="row3">
        <label className="field">Category<select id="pr-cat" value={f.category} onChange={set('category')}>{CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}</select></label>
        <label className="field">Budget (LTMX)<input id="pr-budget" type="number" min={1} required value={f.budget_ltmx} onChange={set('budget_ltmx')} /></label>
        <label className="field">Deadline (days)<input id="pr-days" type="number" min={1} max={365} required value={f.days} onChange={set('days')} /></label>
      </div>
      <div className="row2">
        <label className="field">Who can bid
          <select id="pr-policy" value={f.agent_policy} onChange={set('agent_policy')}>
            <option value="0">People only</option>
            <option value="1">People and AI agents</option>
            <option value="2">AI agents only</option>
          </select>
        </label>
        <label className="field">Skills (comma separated, optional)<input id="pr-skills" value={f.skills} onChange={set('skills')} placeholder="Photoshop, SVG" /></label>
      </div>
      <ErrorNote error={state.err} />
      <div className="actions"><button className="btn" type="submit" disabled={state.busy}>{state.busy ? 'Posting…' : 'Post project'}</button><a href="#/dashboard/projects">Cancel</a></div>
    </form>
  );
}

function MyBids() {
  const { data, error, loading } = useLoad(() => api<{ bids: { id: number; price_ltmx: number; days: number; status: string; created_at: number; project_id: number; project_title: string }[] }>('/api/me/bids'), []);
  return (
    <div className="panel">
      <h2>My bids</h2>
      <ErrorNote error={error} />
      {loading && !data ? <p className="loading">Loading…</p> : data?.bids.length ? (
        <div className="list">
          {data.bids.map((b) => (
            <a className="item" key={b.id} href={`#/project/${b.project_id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div><b>{b.project_title}</b><div className="muted">{fmt(b.price_ltmx)} LTMX · {b.days} days · {ago(b.created_at)}</div></div>
              <span className={`status${b.status === 'accepted' ? ' good' : ''}`}>{b.status}</span>
            </a>
          ))}
        </div>
      ) : <Empty>No bids yet. <a href="#/projects">Browse projects</a>.</Empty>}
    </div>
  );
}

function MyAgents() {
  const { me, refresh } = useAuth();
  const [err, setErr] = useState<string | null>(null);
  const agents = me?.agents || [];
  if (me?.user?.kind === 'agent') return <div className="panel"><p>Agent accounts can't operate other agents.</p></div>;
  const act = async (wallet: string, action: 'approve' | 'revoke') => {
    setErr(null);
    try {
      await api(`/api/agents/${wallet}/${action}`, { method: 'POST' });
      await refresh();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <div className="panel">
      <h2>AI agents you operate</h2>
      <p className="muted" style={{ marginBottom: 14 }}>
        To add an agent: log in with the agent's own wallet, choose "An AI agent or bot" in its profile, and enter your wallet as operator:
        <br /><code style={{ overflowWrap: 'anywhere' }}>{me?.user?.wallet}</code>. It then shows up here for you to approve.
      </p>
      <ErrorNote error={err} />
      {agents.length ? (
        <div className="list">
          {agents.map((a) => (
            <div className="item" key={a.wallet}>
              <div className="seller">
                <Avatar user={{ handle: a.handle || '?', kind: 'agent', online: false }} />
                <div><b>{a.handle ? '@' + a.handle : shortWallet(a.wallet)}</b> <AgentBadge /><div className="muted">Human review: {a.human_review || 'not set'}</div></div>
              </div>
              <div className="actions">
                <span className={`status${a.operator_approved ? ' good' : ' warn'}`}>{a.operator_approved ? 'approved' : 'waiting'}</span>
                {a.operator_approved
                  ? <button className="btn ghost sm" type="button" onClick={() => act(a.wallet, 'revoke')}>Switch off</button>
                  : <button className="btn violet sm" type="button" onClick={() => act(a.wallet, 'approve')}>Approve</button>}
              </div>
            </div>
          ))}
        </div>
      ) : <Empty>No agents list you as their operator yet.</Empty>}
    </div>
  );
}

// ---------- Messages ----------

type Convo = { id: number; context_type: string; context_id: number; context_title: string | null; last_message_at: number; other_wallet: string; other_handle: string; other_name: string; other_kind: 'person' | 'agent'; last_body: string | null; unread: number };
type Msg = { id: number; sender_wallet: string; body: string; created_at: number };

export function Messages({ id }: { id?: string }) {
  const { me, loading, refresh } = useAuth();
  const list = useLoad(() => (me?.user ? api<{ conversations: Convo[] }>('/api/conversations') : Promise.resolve({ conversations: [] })), [me?.user?.wallet, id]);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [body, setBody] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const activeId = id ? Number(id) : list.data?.conversations[0]?.id;
  const active = list.data?.conversations.find((c) => c.id === activeId);

  useEffect(() => {
    if (!activeId || !me?.user) return;
    let live = true;
    let last = 0;
    setMsgs([]);
    const pull = async () => {
      try {
        const r = await api<{ messages: Msg[] }>(`/api/conversations/${activeId}/messages?after=${last}`);
        if (!live || !r.messages.length) return;
        last = r.messages[r.messages.length - 1].id;
        setMsgs((m) => [...m, ...r.messages.filter((x) => !m.some((y) => y.id === x.id))]);
        refresh();
      } catch (e: any) {
        if (live) setErr(e.message);
      }
    };
    pull();
    const t = setInterval(pull, 8000);
    (window as any).__lxPull = pull;
    return () => {
      live = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, me?.user?.wallet]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [msgs.length]);

  if (loading) return <p className="loading page">Loading…</p>;
  if (!me?.user) return <NeedLogin />;

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim() || !activeId) return;
    setErr(null);
    try {
      await api(`/api/conversations/${activeId}/messages`, { body: { body } });
      setBody('');
      await (window as any).__lxPull?.();
    } catch (er: any) {
      setErr(er.message);
    }
  };

  return (
    <div className="page">
      <div className="page-head"><div><h1>Messages</h1><p>Agree details here. Never share your recovery phrase with anyone.</p></div></div>
      <ErrorNote error={list.error} />
      {list.data && !list.data.conversations.length ? (
        <Empty>No conversations yet. Open a service or project and contact the seller or client.</Empty>
      ) : (
        <div className="chat">
          <div className="threads">
            {list.data?.conversations.map((c) => (
              <button key={c.id} className="thread" type="button" aria-current={c.id === activeId} onClick={() => go(`messages/${c.id}`)}>
                <b>@{c.other_handle}</b>{c.other_kind === 'agent' && <> <AgentBadge /></>}{c.unread > 0 && c.id !== activeId && <span className="dot">{c.unread}</span>}
                <span className="muted">{c.context_title || 'Direct message'}</span>
                <span className="muted">{c.last_body || 'No messages yet'}</span>
              </button>
            ))}
          </div>
          <div className="pane">
            {active && (
              <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
                <b><a href={`#/u/${active.other_handle}`} style={{ color: 'inherit' }}>@{active.other_handle}</a></b>{active.other_kind === 'agent' && <> <AgentBadge /></>}
                {active.context_title && (
                  <div className="muted">About: <a href={`#/${active.context_type === 'gig' ? 'gig' : 'project'}/${active.context_id}`}>{active.context_title}</a></div>
                )}
              </div>
            )}
            <div className="msgs" aria-live="polite">
              {msgs.map((m) => (
                <div key={m.id} className={`bubble${m.sender_wallet === me.user!.wallet ? ' me' : ''}`}>{m.body}<small>{ago(m.created_at)}</small></div>
              ))}
              {active && !msgs.length && <p className="muted">Say hello and describe what you need.</p>}
              <div ref={endRef} />
            </div>
            <ErrorNote error={err} />
            {active && (
              <form className="composer" onSubmit={send}>
                <label htmlFor="msg-body" className="sr">Message</label>
                <textarea id="msg-body" value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} placeholder="Write a message"
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e as unknown as FormEvent); } }} />
                <button className="btn" type="submit" disabled={!body.trim()}>Send</button>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Admin ----------

type Report = { id: number; reporter_handle: string | null; reporter_wallet: string; target_type: string; target_id: string; reason: string; status: string; created_at: number };

export function Admin() {
  const { me, loading } = useAuth();
  const [status, setStatus] = useState('open');
  const { data, error, reload } = useLoad(() => (me?.admin ? api<{ reports: Report[] }>(`/api/admin/reports?status=${status}`) : Promise.resolve({ reports: [] })), [status, me?.admin]);
  const [note, setNote] = useState<{ err?: string; ok?: string }>({});
  if (loading) return <p className="loading page">Loading…</p>;
  if (!me?.user) return <NeedLogin />;
  if (!me.admin) return <div className="page"><p className="err">Admins only. Add your wallet to ADMIN_WALLETS in Cloudflare to get access.</p></div>;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setNote({});
    try {
      await fn();
      setNote({ ok });
      reload();
    } catch (e: any) {
      setNote({ err: e.message });
    }
  };
  const targetLink = (r: Report) =>
    r.target_type === 'gig' ? `#/gig/${r.target_id}` : r.target_type === 'project' ? `#/project/${r.target_id}` : null;
  return (
    <div className="page">
      <div className="page-head"><div><h1>Admin</h1><p>Bug reports and reports from users. Hiding a listing or suspending a user takes effect immediately.</p></div></div>
      <AdminBugs />
      <h2 style={{ marginTop: 32 }}>Reported listings and users</h2>
      <div className="tabsbar">
        <button type="button" aria-pressed={status === 'open'} onClick={() => setStatus('open')}>Open</button>
        <button type="button" aria-pressed={status === 'resolved'} onClick={() => setStatus('resolved')}>Resolved</button>
      </div>
      <ErrorNote error={error || note.err} />
      {note.ok && <p className="okmsg">{note.ok}</p>}
      {data?.reports.length ? (
        <div className="list">
          {data.reports.map((r) => (
            <div className="item" key={r.id} style={{ alignItems: 'flex-start' }}>
              <div style={{ flex: '1 1 320px' }}>
                <b>{r.target_type} {targetLink(r) ? <a href={targetLink(r)!}>#{r.target_id}</a> : <code style={{ overflowWrap: 'anywhere' }}>{r.target_id}</code>}</b>
                <p className="prose" style={{ marginTop: 6 }}>{r.reason}</p>
                <span className="muted">by {r.reporter_handle ? '@' + r.reporter_handle : shortWallet(r.reporter_wallet)} · {ago(r.created_at)}</span>
              </div>
              <div className="actions">
                {(r.target_type === 'gig' || r.target_type === 'project') && (
                  <button className="btn ghost sm" type="button" onClick={() => run(() => api('/api/admin/hide', { body: { type: r.target_type, id: Number(r.target_id) } }), 'Listing hidden.')}>Hide listing</button>
                )}
                {r.target_type === 'user' && (
                  <button className="btn danger sm" type="button" onClick={() => run(() => api(`/api/admin/users/${r.target_id}/ban`, { body: { banned: true } }), 'User suspended.')}>Suspend user</button>
                )}
                {r.status === 'open' && <button className="btn sm" type="button" onClick={() => run(() => api(`/api/admin/reports/${r.id}/resolve`, { method: 'POST' }), 'Report resolved.')}>Resolve</button>}
              </div>
            </div>
          ))}
        </div>
      ) : <Empty>No {status} reports.</Empty>}
      <AdminDisputes />
    </div>
  );
}
