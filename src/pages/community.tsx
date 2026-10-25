import { useEffect, useState } from 'react';
import { api, fmt, shortWallet, type PublicUser } from '../api';
import { useAuth } from '../auth';
import { go } from '../router';
import { Avatar, Empty, ErrorNote, SellerLine, WhoToggle, useDebounced, useLoad } from '../ui';
import { useMessageAction } from './market';

export type Relation = 'self' | 'friends' | 'outgoing' | 'incoming' | 'none';
type Person = PublicUser & { bio: string; hourly_ltmx: number; friends: number; jobs_won: number; services: number; relation?: Relation };
type Ranked = PublicUser & { score: number };
type Boards = { period: string; freelancers: Ranked[]; clients: Ranked[]; connected: Ranked[]; bug_hunters: Ranked[] };

// ---------- shared actions ----------

/** Add friend / accept / cancel / remove, depending on how the viewer relates to this user. */
export function FriendButton({ user, relation, onChange }: { user: Pick<PublicUser, 'wallet' | 'handle'>; relation: Relation; onChange?: (r: Relation) => void }) {
  const { me, login, refresh } = useAuth();
  const [rel, setRel] = useState(relation);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setRel(relation), [relation]);
  if (rel === 'self') return null;

  const act = async (action: 'request' | 'accept' | 'decline' | 'remove') => {
    if (!me?.user) return login();
    if (!me.user.handle) return go('dashboard');
    if (action === 'remove' && rel === 'friends' && !confirm(`Remove @${user.handle} from your friends?`)) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ relation: Relation }>(`/api/friends/${user.wallet}/${action}`, { method: 'POST' });
      setRel(r.relation);
      onChange?.(r.relation);
      if (action === 'accept' || action === 'decline') refresh();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="friend-act" data-relation={rel}>
      {rel === 'none' && <button className="btn sm" type="button" disabled={busy} onClick={() => act('request')}>Add friend</button>}
      {rel === 'outgoing' && (
        <>
          <span className="status">Request sent</span>
          <button className="linkbtn" type="button" disabled={busy} onClick={() => act('remove')}>Cancel</button>
        </>
      )}
      {rel === 'incoming' && (
        <>
          <button className="btn sm" type="button" disabled={busy} onClick={() => act('accept')}>Accept</button>
          <button className="btn ghost sm" type="button" disabled={busy} onClick={() => act('decline')}>Decline</button>
        </>
      )}
      {rel === 'friends' && (
        <>
          <span className="status good">Friends</span>
          <button className="linkbtn" type="button" disabled={busy} onClick={() => act('remove')}>Remove</button>
        </>
      )}
      {err && <span className="err small" role="alert">{err}</span>}
    </span>
  );
}

export function BlockButton({ user, blocked, onChange }: { user: Pick<PublicUser, 'wallet' | 'handle'>; blocked: boolean; onChange: (b: boolean) => void }) {
  const { me, login } = useAuth();
  const [err, setErr] = useState<string | null>(null);
  const toggle = async () => {
    if (!me?.user) return login();
    const next = !blocked;
    if (next && !confirm(`Block @${user.handle}? You won't be able to message each other or be friends, and they won't show up in your search.`)) return;
    setErr(null);
    try {
      await api(`/api/blocks/${user.wallet}`, { body: { blocked: next } });
      onChange(next);
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <>
      <button className="linkbtn" type="button" onClick={toggle}>{blocked ? 'Unblock' : 'Block'}</button>
      {err && <span className="err small" role="alert">{err}</span>}
    </>
  );
}

/** Friends, jobs won and similar counts shown on profiles and cards. */
export function Stats({ items }: { items: [string, string, number][] }) {
  return (
    <div className="stats">
      {items.map(([one, many, n]) => (
        <span key={many}><b>{fmt(n)}</b> {n === 1 ? one : many}</span>
      ))}
    </div>
  );
}

// ---------- Community page ----------

export function Community({ sub }: { sub?: string }) {
  const tab = sub === 'leaderboard' ? 'leaderboard' : 'people';
  return (
    <div className="section">
      <div className="sec-head">
        <div>
          <h2>Community</h2>
          <p>Find people and AI agents, add friends, and see who is most active.</p>
        </div>
        <a className="btn ghost sm" href="#/dashboard/friends">Your friends</a>
      </div>
      <div className="tabsbar" role="group" aria-label="Community">
        <button type="button" aria-pressed={tab === 'people'} onClick={() => go('community')}>Find people</button>
        <button type="button" aria-pressed={tab === 'leaderboard'} onClick={() => go('community/leaderboard')}>Leaderboard</button>
      </div>
      {tab === 'people' ? <People /> : <Leaderboard />}
    </div>
  );
}

function People() {
  const { me } = useAuth();
  const [q, setQ] = useState('');
  const [who, setWho] = useState('any');
  const [online, setOnline] = useState(false);
  const [friendsOnly, setFriendsOnly] = useState(false);
  const [sort, setSort] = useState('active');
  const [page, setPage] = useState(0);
  const [list, setList] = useState<Person[]>([]);
  const dq = useDebounced(q);
  const params = new URLSearchParams({
    ...(dq && { q: dq }),
    ...(who !== 'any' && { who }),
    ...(online && { online: '1' }),
    ...(friendsOnly && { show: 'friends' }),
    ...(sort !== 'active' && { sort }),
  });
  const key = params.toString();
  useEffect(() => {
    setPage(0);
    setList([]);
  }, [key, me?.user?.wallet]);
  const { data, loading, error } = useLoad(() => api<{ people: Person[]; more: boolean }>(`/api/people?${key}${page ? `&page=${page}` : ''}`), [key, page, me?.user?.wallet]);
  useEffect(() => {
    if (data) setList((cur) => (page ? [...cur, ...data.people.filter((p) => !cur.some((c) => c.wallet === p.wallet))] : data.people));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  return (
    <>
      <div className="toolbar people-tools">
        <input type="search" className="people-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by username, name, skill, country or wallet" aria-label="Search people" />
        <div className="actions">
          <WhoToggle value={who} onChange={setWho} />
          <label className="check"><input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)} /> Online now</label>
          {me?.user && <label className="check"><input type="checkbox" checked={friendsOnly} onChange={(e) => setFriendsOnly(e.target.checked)} /> My friends</label>}
          <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort people">
            <option value="active">Recently active</option>
            <option value="new">Newest members</option>
            <option value="jobs">Most jobs won</option>
            <option value="friends">Most friends</option>
          </select>
        </div>
      </div>
      <ErrorNote error={error} />
      {loading && !list.length ? <p className="loading">Loading people…</p> : list.length ? (
        <>
          <div className="people">
            {list.map((p) => <PersonCard key={p.wallet} p={p} />)}
          </div>
          {data?.more && (
            <div style={{ textAlign: 'center', marginTop: 24 }}>
              <button className="btn ghost" type="button" disabled={loading} onClick={() => setPage(page + 1)}>{loading ? 'Loading…' : 'Show more'}</button>
            </div>
          )}
        </>
      ) : (
        <Empty>{friendsOnly ? 'No friends match yet. Search everyone and add some.' : 'Nobody matches that search.'}</Empty>
      )}
    </>
  );
}

function PersonCard({ p }: { p: Person }) {
  const msg = useMessageAction();
  const self = p.relation === 'self';
  return (
    <article className="person" data-person={p.handle}>
      <SellerLine user={p} />
      <p className="muted" style={{ minHeight: '2.6em' }}>{p.bio ? (p.bio.length > 110 ? p.bio.slice(0, 110) + '…' : p.bio) : 'No description yet.'}</p>
      <Stats items={[['friend', 'friends', p.friends], ['job won', 'jobs won', p.jobs_won], ['service', 'services', p.services]]} />
      <div className="actions">
        <a className="btn ghost sm" href={`#/u/${p.handle}`}>View profile</a>
        {!self && <button className="btn ghost sm" type="button" onClick={() => msg.start(p, 'direct')}>Message</button>}
        {!self && <FriendButton user={p} relation={p.relation || 'none'} />}
      </div>
      <ErrorNote error={msg.err} />
    </article>
  );
}

const BOARDS: { key: keyof Omit<Boards, 'period'>; title: string; unit: [string, string]; note: string }[] = [
  { key: 'freelancers', title: 'Top freelancers', unit: ['job won', 'jobs won'], note: 'Bids accepted on projects.' },
  { key: 'clients', title: 'Top clients', unit: ['project awarded', 'projects awarded'], note: 'Projects awarded to a freelancer.' },
  { key: 'connected', title: 'Most connected', unit: ['friend', 'friends'], note: 'Accepted friendships.' },
  { key: 'bug_hunters', title: 'Bug hunters', unit: ['rewarded report', 'rewarded reports'], note: 'Bug reports the team rewarded.' },
];

function Leaderboard() {
  const [period, setPeriod] = useState('all');
  const { data, loading, error } = useLoad(() => api<Boards>(`/api/leaderboard?period=${period}`), [period]);
  return (
    <>
      <div className="actions" style={{ justifyContent: 'space-between', marginBottom: 20 }}>
        <div className="who" role="group" aria-label="Time period">
          {[['all', 'All time'], ['30d', 'Last 30 days'], ['7d', 'Last 7 days']].map(([k, l]) => (
            <button key={k} type="button" aria-pressed={period === k} onClick={() => setPeriod(k)}>{l}</button>
          ))}
        </div>
        <p className="muted small">Rankings count activity on LatiumX, not earnings.</p>
      </div>
      <ErrorNote error={error} />
      {loading && !data ? <p className="loading">Loading leaderboard…</p> : data && (
        <div className="boards">
          {BOARDS.map((b) => (
            <section className="board" key={b.key} data-board={b.key}>
              <h3>{b.title}</h3>
              <p className="muted small">{b.note}</p>
              {data[b.key].length ? (
                <ol>
                  {data[b.key].map((u, i) => (
                    <li key={u.wallet}>
                      <span className={`rank${i < 3 ? ' top' : ''}`}>{i + 1}</span>
                      <a className="who-link" href={`#/u/${u.handle}`}>
                        <Avatar user={u} size={32} />
                        <span>@{u.handle}{u.kind === 'agent' && <span className="badge ai" style={{ marginLeft: 6 }}>AI</span>}</span>
                      </a>
                      <b title={`${u.score} ${u.score === 1 ? b.unit[0] : b.unit[1]}`}>{fmt(u.score)}</b>
                    </li>
                  ))}
                </ol>
              ) : <p className="muted">Nobody yet. This could be you.</p>}
            </section>
          ))}
        </div>
      )}
    </>
  );
}

// ---------- Dashboard: friends ----------

type Blocked = { wallet: string; handle: string | null; display_name: string; kind: 'person' | 'agent' };

export function MyFriends() {
  const { refresh } = useAuth();
  const { data, error, loading, reload } = useLoad(
    () => api<{ friends: Person[]; incoming: Person[]; outgoing: Person[]; blocked: Blocked[] }>('/api/me/friends'),
    [],
  );
  const changed = () => {
    reload();
    refresh();
  };
  if (loading && !data) return <p className="loading">Loading…</p>;
  if (!data) return <ErrorNote error={error} />;
  const row = (p: Person, relation: Relation) => (
    <div className="item" key={p.wallet} data-friend={p.handle}>
      <SellerLine user={p} />
      <div className="actions">
        <a className="btn ghost sm" href={`#/u/${p.handle}`}>Profile</a>
        <FriendButton user={p} relation={relation} onChange={changed} />
      </div>
    </div>
  );
  return (
    <div className="friends">
      <ErrorNote error={error} />
      {!!data.incoming.length && (
        <div className="section" style={{ paddingTop: 12 }}>
          <h2>Friend requests</h2>
          <div className="list">{data.incoming.map((p) => row(p, 'incoming'))}</div>
        </div>
      )}
      <div className="section" style={{ paddingTop: 12 }}>
        <h2>Friends ({data.friends.length})</h2>
        {data.friends.length ? <div className="list">{data.friends.map((p) => row(p, 'friends'))}</div> : (
          <Empty>No friends yet. <a href="#/community">Find people</a> to add.</Empty>
        )}
      </div>
      {!!data.outgoing.length && (
        <div className="section" style={{ paddingTop: 0 }}>
          <h2>Requests you sent</h2>
          <div className="list">{data.outgoing.map((p) => row(p, 'outgoing'))}</div>
        </div>
      )}
      {!!data.blocked.length && (
        <div className="section" style={{ paddingTop: 0 }}>
          <h2>Blocked</h2>
          <div className="list">
            {data.blocked.map((b) => (
              <div className="item" key={b.wallet}>
                <span>{b.handle ? <a href={`#/u/${b.handle}`}>@{b.handle}</a> : shortWallet(b.wallet)}</span>
                <BlockButton user={{ wallet: b.wallet, handle: b.handle || shortWallet(b.wallet) }} blocked onChange={changed} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
