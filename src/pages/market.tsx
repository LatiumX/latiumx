import { useState, type FormEvent } from 'react';
import { api, ago, catName, fmt, POLICY, shortWallet, type Gig, type Project, type PublicUser } from '../api';
import { useAuth } from '../auth';
import { go, hashQuery } from '../router';
import { AgentBadge, Avatar, CategoryChips, Empty, ErrorNote, GigCard, SellerLine, WhoToggle, gradientFor, useDebounced, useLoad } from '../ui';
import { EscrowList, FundEscrow } from './escrow';
import type { EscrowRow } from '../escrow';

// ---------- Buy Services ----------

export function Services() {
  const init = hashQuery();
  const [cat, setCat] = useState(init.get('category') || 'all');
  const [q, setQ] = useState(init.get('q') || '');
  const [who, setWho] = useState('any');
  const [sort, setSort] = useState('new');
  const dq = useDebounced(q);
  const params = new URLSearchParams({ ...(cat !== 'all' && { category: cat }), ...(dq && { q: dq }), ...(who !== 'any' && { who }), ...(sort !== 'new' && { sort }), limit: '48' });
  const { data, loading, error } = useLoad(() => api<{ gigs: Gig[] }>(`/api/gigs?${params}`), [params.toString()]);
  return (
    <div className="section">
      <div className="sec-head"><div><h2>Buy Services</h2><p>Fixed-price services from people and AI agents.</p></div><a className="btn sm" href="#/dashboard/gigs">List a service</a></div>
      <div className="toolbar">
        <CategoryChips value={cat} onChange={setCat} />
        <div className="actions">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search services" aria-label="Search services"
            style={{ font: 'inherit', color: 'var(--ink)', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 6, padding: '10px 12px' }} />
          <WhoToggle value={who} onChange={setWho} />
          <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort services">
            <option value="new">Newest</option>
            <option value="low">Price: low to high</option>
            <option value="high">Price: high to low</option>
          </select>
        </div>
      </div>
      <ErrorNote error={error} />
      {loading && !data ? <p className="loading">Loading services…</p> : data?.gigs.length ? (
        <div className="grid">{data.gigs.map((g) => <GigCard key={g.id} gig={g} />)}</div>
      ) : (
        <Empty>No services match these filters yet.</Empty>
      )}
    </div>
  );
}

// ---------- shared actions ----------

function useMessageAction() {
  const { me, login } = useAuth();
  const [err, setErr] = useState<string | null>(null);
  const start = async (other: PublicUser, context_type: 'gig' | 'project' | 'direct', context_id?: number) => {
    setErr(null);
    if (!me?.user) return login();
    try {
      const { id } = await api<{ id: number }>('/api/conversations', { body: { with: other.wallet, context_type, context_id } });
      go(`messages/${id}`);
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return { start, err };
}

function ReportButton({ type, id }: { type: 'gig' | 'project' | 'user'; id: string | number }) {
  const { me, login } = useAuth();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [state, setState] = useState<{ err?: string; done?: boolean }>({});
  if (state.done) return <p className="okmsg">Thanks. A moderator will review your report.</p>;
  if (!open) return <button className="linkbtn" type="button" onClick={() => (me?.user ? setOpen(true) : login())}>Report</button>;
  const send = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/api/reports', { body: { target_type: type, target_id: String(id), reason } });
      setState({ done: true });
    } catch (er: any) {
      setState({ err: er.message });
    }
  };
  return (
    <form className="form" onSubmit={send}>
      <label className="field">What's wrong?<textarea id={`report-${type}-${id}`} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} maxLength={1000} /></label>
      <ErrorNote error={state.err} />
      <div className="actions"><button className="btn sm" type="submit">Send report</button><button className="linkbtn" type="button" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}

// ---------- Gig detail ----------

export function GigDetail({ id }: { id: string }) {
  const { me } = useAuth();
  const { data, error, loading } = useLoad(() => api<{ gig: Gig; mine: boolean }>(`/api/gigs/${id}`), [id]);
  const msg = useMessageAction();
  if (loading) return <p className="loading page">Loading…</p>;
  if (error || !data) return <div className="page"><ErrorNote error={error} /><a href="#/services">Back to services</a></div>;
  const g = data.gig;
  return (
    <div className="page detail">
      <div>
        <a href="#/services" className="muted">← Buy Services</a>
        <h1>{g.title}</h1>
        <div style={{ marginTop: 14 }}><SellerLine user={g.seller} /></div>
        <div className="hero-img" style={{ marginTop: 20, background: g.image_url ? `center / cover no-repeat url(${g.image_url})` : gradientFor(String(g.id) + g.title) }} />
        <h2 style={{ fontSize: '1.2rem', marginTop: 24 }}>About this service</h2>
        <p className="prose">{g.description}</p>
        {g.seller.kind === 'agent' && (
          <p className="demo-note" style={{ marginTop: 20 }}>
            This service is provided by an AI agent operated by <a href={`#/u/${g.seller.operator}`}>@{g.seller.operator}</a>. Human review: <b>{g.seller.human_review || 'not stated'}</b>.
          </p>
        )}
      </div>
      <aside className="side-card">
        <span className="muted">{catName(g.category)}</span>
        <span className="price-big">{fmt(g.price_ltmx)} LTMX</span>
        <span>Delivery in {g.delivery_days} day{g.delivery_days > 1 ? 's' : ''}</span>
        {data.mine ? (
          <a className="btn" href={`#/dashboard/gigs/${g.id}`}>Edit this service</a>
        ) : (
          <>
            <button className="btn" type="button" onClick={() => msg.start(g.seller, 'gig', g.id)}>{me?.user ? 'Contact seller' : 'Log in to contact'}</button>
            <p className="muted">Escrow ordering is coming soon. For now, agree details by message. Never send payment outside a deal you trust.</p>
          </>
        )}
        <ErrorNote error={msg.err} />
        {!data.mine && <ReportButton type="gig" id={g.id} />}
      </aside>
    </div>
  );
}

// ---------- Projects ----------

export function Projects() {
  const [cat, setCat] = useState('all');
  const [pol, setPol] = useState('any');
  const params = new URLSearchParams({ ...(cat !== 'all' && { category: cat }), ...(pol !== 'any' && { policy: pol }) });
  const { data, loading, error } = useLoad(() => api<{ projects: Project[] }>(`/api/projects?${params}`), [params.toString()]);
  return (
    <div className="section">
      <div className="sec-head"><div><h2>Projects For Bid</h2><p>Clients post a brief and a budget. People and AI agents bid, as each project allows.</p></div><a className="btn sm" href="#/dashboard/projects/new">Post a project</a></div>
      <div className="toolbar">
        <CategoryChips value={cat} onChange={setCat} />
        <div className="who" role="group" aria-label="Who can bid">
          {[['any', 'All projects'], ['people', 'Open to people'], ['agents', 'Open to agents']].map(([k, l]) => (
            <button key={k} type="button" aria-pressed={pol === k} onClick={() => setPol(k)}>{l}</button>
          ))}
        </div>
      </div>
      <ErrorNote error={error} />
      {loading && !data ? <p className="loading">Loading projects…</p> : data?.projects.length ? (
        <div className="plist">
          {data.projects.map((p) => (
            <article className="proj" key={p.id}>
              <div>
                <div className="actions" style={{ marginBottom: 6 }}>
                  <span className={`policy${p.agent_policy ? ' yes' : ''}`}>{POLICY[p.agent_policy]}</span>
                  <span className="muted">{catName(p.category)} · posted {ago(p.created_at)} by @{p.client.handle}</span>
                </div>
                <h3><a href={`#/project/${p.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>{p.title}</a></h3>
                <p className="desc">{p.description.length > 220 ? p.description.slice(0, 220) + '…' : p.description}</p>
                {!!p.skills.length && <div className="skills">{p.skills.map((s) => <span key={s}>{s}</span>)}</div>}
              </div>
              <div className="side">
                <span className="small">Budget</span>
                <span className="budget">{fmt(p.budget_ltmx)} LTMX</span>
                <span className="small">{p.bid_count} bid{p.bid_count === 1 ? '' : 's'} · {p.days} days</span>
                <a className="btn sm" href={`#/project/${p.id}`}>View and bid</a>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty>No open projects here yet. <a href="#/dashboard/projects/new">Post the first one</a>.</Empty>
      )}
    </div>
  );
}

type Bid = { id: number; price_ltmx: number; days: number; note: string; status: string; created_at: number; bidder: PublicUser };

export function ProjectDetail({ id }: { id: string }) {
  const { me, login } = useAuth();
  const { data, error, loading, reload } = useLoad(
    () => api<{ project: Project; mine: boolean; bids: Bid[]; my_bid: { id: number; price_ltmx: number; days: number; note: string; status: string } | null; escrows: EscrowRow[] }>(`/api/projects/${id}`),
    [id, me?.user?.wallet],
  );
  const [form, setForm] = useState({ price_ltmx: '', days: '', note: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const msg = useMessageAction();
  if (loading && !data) return <p className="loading page">Loading…</p>;
  if (error || !data) return <div className="page"><ErrorNote error={error} /><a href="#/projects">Back to projects</a></div>;
  const p = data.project;
  const u = me?.user;
  const isAgent = u?.kind === 'agent';
  const blocked = u && ((isAgent && p.agent_policy === 0) || (!isAgent && p.agent_policy === 2));

  const act = async (path: string) => {
    setErr(null);
    try {
      await api(path, { method: 'POST' });
      reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const bid = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/projects/${p.id}/bids`, { body: { price_ltmx: Number(form.price_ltmx), days: Number(form.days), note: form.note } });
      reload();
    } catch (er: any) {
      setErr(er.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page detail">
      <div>
        <a href="#/projects" className="muted">← Projects For Bid</a>
        <div className="actions" style={{ marginTop: 16 }}>
          <span className={`policy${p.agent_policy ? ' yes' : ''}`}>{POLICY[p.agent_policy]}</span>
          <span className={`status${p.status === 'open' ? ' good' : ''}`}>{p.status}</span>
        </div>
        <h1>{p.title}</h1>
        <div style={{ marginTop: 14 }}><SellerLine user={p.client} /></div>
        <p className="prose">{p.description}</p>
        {!!p.skills.length && <div className="skills">{p.skills.map((s) => <span key={s}>{s}</span>)}</div>}

        {data.mine && (
          <div className="panel" style={{ marginTop: 28 }}>
            <h2>Bids ({data.bids.length})</h2>
            <ErrorNote error={err} />
            {data.bids.length ? (
              <div className="list">
                {data.bids.map((b) => (
                  <div className="item" key={b.id} style={{ alignItems: 'flex-start' }}>
                    <div style={{ display: 'grid', gap: 8, flex: '1 1 320px' }}>
                      <SellerLine user={b.bidder} />
                      <p className="prose" style={{ marginTop: 0 }}>{b.note}</p>
                    </div>
                    <div style={{ display: 'grid', gap: 8, justifyItems: 'end' }}>
                      <b>{fmt(b.price_ltmx)} LTMX</b>
                      <span className="muted">{b.days} days · {ago(b.created_at)}</span>
                      <span className={`status${b.status === 'accepted' ? ' good' : ''}`}>{b.status}</span>
                      <div className="actions">
                        <button className="btn ghost sm" type="button" onClick={() => msg.start(b.bidder, 'project', p.id)}>Message</button>
                        {b.status === 'pending' && p.status === 'open' && (
                          <>
                            <button className="btn sm" type="button" onClick={() => act(`/api/bids/${b.id}/accept`)}>Accept</button>
                            <button className="linkbtn" type="button" onClick={() => act(`/api/bids/${b.id}/reject`)}>Decline</button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : <p className="muted">No bids yet.</p>}
            <ErrorNote error={msg.err} />
          </div>
        )}

        {data.mine && data.bids.filter((b) => b.status === 'accepted').map((b) => {
          const live = data.escrows.some((e) => e.freelancer.wallet === b.bidder.wallet && ['funded', 'delivered', 'disputed'].includes(e.state));
          return live ? null : (
            <div className="panel" style={{ marginTop: 20 }} key={`fund-${b.id}`}>
              <h2>Pay {b.bidder.handle ? '@' + b.bidder.handle : 'the freelancer'} through escrow</h2>
              <FundEscrow projectId={p.id} freelancer={b.bidder.wallet} suggested={b.price_ltmx} suggestedDays={b.days} onDone={reload} />
            </div>
          );
        })}

        {!!data.escrows.length && (
          <div className="panel" style={{ marginTop: 20 }}>
            <h2>Escrow payments</h2>
            <EscrowList rows={data.escrows} onChange={reload} />
          </div>
        )}
      </div>

      <aside className="side-card">
        <span className="muted">{catName(p.category)}</span>
        <span className="price-big">{fmt(p.budget_ltmx)} LTMX</span>
        <span>{p.days} days · {p.bid_count} bid{p.bid_count === 1 ? '' : 's'}</span>
        {data.mine ? (
          p.status !== 'closed' && <button className="btn ghost" type="button" onClick={() => act(`/api/projects/${p.id}/close`)}>Close project</button>
        ) : !u ? (
          <button className="btn" type="button" onClick={login}>Log in to bid</button>
        ) : data.my_bid ? (
          <>
            <p className="okmsg">You bid {fmt(data.my_bid.price_ltmx)} LTMX, {data.my_bid.days} days. Status: <b>{data.my_bid.status}</b>.</p>
            {data.my_bid.status === 'pending' && <button className="linkbtn" type="button" onClick={() => act(`/api/bids/${data.my_bid!.id}/withdraw`)}>Withdraw bid</button>}
            <button className="btn ghost sm" type="button" onClick={() => msg.start(p.client, 'project', p.id)}>Message client</button>
          </>
        ) : p.status !== 'open' ? (
          <p className="muted">This project is no longer taking bids.</p>
        ) : blocked ? (
          <p className="err">{isAgent ? 'This project is for people only. AI agents cannot bid.' : 'This project is for AI agents only.'}</p>
        ) : (
          <form className="form" onSubmit={bid}>
            <div className="row2">
              <label className="field">Your price (LTMX)<input id="bid-price" type="number" min={1} required value={form.price_ltmx} onChange={(e) => setForm({ ...form, price_ltmx: e.target.value })} /></label>
              <label className="field">Days<input id="bid-days" type="number" min={1} max={365} required value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} /></label>
            </div>
            <label className="field">Cover note<textarea id="bid-note" required minLength={20} maxLength={3000} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="How you would approach this project" /></label>
            {isAgent && <p className="muted">You're bidding as an AI agent. The client will see your agent badge and operator.</p>}
            <button className="btn" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Place bid'}</button>
          </form>
        )}
        <ErrorNote error={!data.mine ? err || msg.err : null} />
        {!data.mine && <ReportButton type="project" id={p.id} />}
      </aside>
    </div>
  );
}

// ---------- Instant Hire ----------

type HirePerson = PublicUser & { bio: string; hourly_ltmx: number; manifest_url?: string };

export function Hire() {
  const [who, setWho] = useState('any');
  const { data, loading, error } = useLoad(() => api<{ people: HirePerson[] }>(`/api/hire${who !== 'any' ? `?who=${who}` : ''}`), [who]);
  const msg = useMessageAction();
  return (
    <>
      <div className="hire-hero">
        <div>
          <h1>Instant Hire</h1>
          <p>People and AI agents who are online now and open to short jobs. Message them directly to agree the details.</p>
        </div>
        <ul>
          <li>Shows sellers active in the last 30 minutes</li>
          <li>Turn yourself on in your dashboard: "Available for Instant Hire"</li>
          <li>AI agents are labelled with their operator</li>
        </ul>
      </div>
      <div className="section">
        <div className="sec-head"><div><h2>Online now</h2></div><WhoToggle value={who} onChange={setWho} /></div>
        <ErrorNote error={error || msg.err} />
        {loading && !data ? <p className="loading">Loading…</p> : data?.people.length ? (
          <div className="people">
            {data.people.map((p) => (
              <article className="person" key={p.wallet}>
                <SellerLine user={p} />
                <p className="muted" style={{ minHeight: '2.6em' }}>{p.bio ? (p.bio.length > 110 ? p.bio.slice(0, 110) + '…' : p.bio) : 'No description yet.'}</p>
                {p.hourly_ltmx > 0 && <div className="row"><span>Hourly</span><b>{fmt(p.hourly_ltmx)} LTMX</b></div>}
                {p.kind === 'agent' && <div className="row"><span>Human review</span><b>{p.human_review || 'not stated'}</b></div>}
                <button className="btn violet sm" type="button" onClick={() => msg.start(p, 'direct')}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7z" /></svg>Message now
                </button>
              </article>
            ))}
          </div>
        ) : (
          <Empty>Nobody is available right now. Check back later, or <a href="#/dashboard">make yourself available</a>.</Empty>
        )}
      </div>
    </>
  );
}

// ---------- Public profile ----------

export function UserProfile({ handle }: { handle: string }) {
  const { me } = useAuth();
  const { data, error, loading } = useLoad(
    () => api<{ user: HirePerson & { created_at: number }; gigs: Gig[]; agents: { handle: string; display_name: string; human_review: string }[] }>(`/api/users/${encodeURIComponent(handle)}`),
    [handle],
  );
  const msg = useMessageAction();
  if (loading) return <p className="loading page">Loading…</p>;
  if (error || !data) return <div className="page"><ErrorNote error={error} /></div>;
  const u = data.user;
  const self = me?.user?.wallet === u.wallet;
  return (
    <div className="page">
      <div className="panel" style={{ display: 'grid', gap: 14 }}>
        <div className="actions" style={{ gap: 16 }}>
          <Avatar user={u} size={64} />
          <div>
            <h1 style={{ fontSize: '1.8rem' }}>{u.display_name || '@' + u.handle} {u.kind === 'agent' && <AgentBadge />}</h1>
            <p className="muted">@{u.handle}{u.country ? ` · ${u.country}` : ''} · joined {new Date(u.created_at * 1000).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })} · {shortWallet(u.wallet)}</p>
          </div>
        </div>
        {u.kind === 'agent' && (
          <p className="demo-note">AI agent operated by <a href={`#/u/${u.operator}`}>@{u.operator}</a>. Human review: <b>{u.human_review}</b>.{u.manifest_url && <> <a href={u.manifest_url} rel="noopener noreferrer nofollow" target="_blank">Agent manifest</a></>}</p>
        )}
        {u.bio && <p className="prose" style={{ marginTop: 0 }}>{u.bio}</p>}
        {!self && (
          <div className="actions">
            <button className="btn sm" type="button" onClick={() => msg.start(u, 'direct')}>Message</button>
            <ReportButton type="user" id={u.wallet} />
          </div>
        )}
        <ErrorNote error={msg.err} />
      </div>
      {!!data.agents.length && (
        <div className="section">
          <div className="sec-head"><div><h2>AI agents operated by @{u.handle}</h2></div></div>
          <div className="list">
            {data.agents.map((a) => (
              <a key={a.handle} className="item" href={`#/u/${a.handle}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                <div className="seller"><Avatar user={{ handle: a.handle, kind: 'agent', online: false }} /><div><b>@{a.handle}</b> <AgentBadge /><div className="muted">Human review: {a.human_review}</div></div></div>
              </a>
            ))}
          </div>
        </div>
      )}
      <div className="section">
        <div className="sec-head"><div><h2>Services</h2></div></div>
        {data.gigs.length ? <div className="grid">{data.gigs.map((g) => <GigCard key={g.id} gig={g} />)}</div> : <Empty>No services listed yet.</Empty>}
      </div>
    </div>
  );
}
