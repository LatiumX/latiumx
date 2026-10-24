import { useEffect, useState, type ReactNode } from 'react';
import { CATEGORIES, catName, fmt, type Gig, type PublicUser } from './api';

const AV = ['#5aa9f5', '#8a1df2', '#d6438c', '#3cbf6e', '#e9a23b', '#2a6fdb'];
const GRADS = [
  'linear-gradient(180deg,#f2a04a 0%,#e8506b 45%,#7b2fd6 100%)',
  'linear-gradient(135deg,#1fb5a8,#2a6fdb)',
  'linear-gradient(135deg,#b7e04a,#1f9e6e)',
  'linear-gradient(135deg,#9b4dff,#ff5fa2)',
  'linear-gradient(135deg,#f6d38a,#e48a4e)',
  'linear-gradient(160deg,#141a33,#3b4aa8)',
];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
export const gradientFor = (seed: string) => GRADS[hash(seed) % GRADS.length];

const BOT = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" aria-hidden="true">
    <rect x="4" y="8" width="16" height="11" rx="3" />
    <path d="M12 4v4M9 13h.01M15 13h.01" />
  </svg>
);

export function Avatar({ user, size }: { user: Pick<PublicUser, 'handle' | 'kind' | 'online'>; size?: number }) {
  const agent = user.kind === 'agent';
  const style = { background: agent ? 'var(--violet)' : AV[hash(user.handle || '') % AV.length], ...(size ? { width: size, height: size } : {}) };
  return (
    <span className={`ava${user.online ? ' on' : ''}${agent ? ' ai' : ''}`} style={style} aria-hidden="true">
      {agent ? BOT : (user.handle || '?').slice(0, 2).toUpperCase()}
    </span>
  );
}

export const AgentBadge = () => <span className="badge ai">AI agent</span>;

export function SellerLine({ user }: { user: PublicUser }) {
  return (
    <div className="seller">
      <Avatar user={user} />
      <div>
        <b>
          <a href={`#/u/${user.handle}`} style={{ color: 'inherit', textDecoration: 'none' }}>@{user.handle}</a>
          {user.kind === 'agent' && <> <AgentBadge /></>}
        </b>
        <div className="meta">
          {user.kind === 'agent' ? (
            <span className="op">Operated by <b>@{user.operator}</b></span>
          ) : (
            <span>{user.country || (user.online ? 'Online' : 'Member')}</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function GigCard({ gig }: { gig: Gig }) {
  return (
    <a className="cardlink" href={`#/gig/${gig.id}`}>
      <article className="card" style={{ width: '100%' }}>
        <div className="thumb" style={{ background: gig.image_url ? `center / cover no-repeat url(${gig.image_url})` : gradientFor(String(gig.id) + gig.title) }}>
          <span className="tag">{catName(gig.category)}</span>
        </div>
        <div className="body">
          <SellerLine user={gig.seller} />
          <p className="title">{gig.title}</p>
        </div>
        <div className="foot">
          <span>Starting at</span>
          <b>{fmt(gig.price_ltmx)} LTMX</b>
        </div>
      </article>
    </a>
  );
}

export function CategoryChips({ value, onChange }: { value: string; onChange: (k: string) => void }) {
  return (
    <div className="chips" role="group" aria-label="Category">
      <button className="chip" type="button" aria-pressed={value === 'all'} onClick={() => onChange('all')}>All</button>
      {CATEGORIES.map((c) => (
        <button key={c.key} className="chip" type="button" aria-pressed={value === c.key} onClick={() => onChange(c.key)}>{c.name}</button>
      ))}
    </div>
  );
}

export function WhoToggle({ value, onChange }: { value: string; onChange: (w: string) => void }) {
  return (
    <div className="who" role="group" aria-label="Seller type">
      {[['any', 'Anyone'], ['people', 'People'], ['agents', 'AI agents']].map(([k, label]) => (
        <button key={k} type="button" aria-pressed={value === k} onClick={() => onChange(k)}>{label}</button>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
  return error ? <p className="err" role="alert">{error}</p> : null;
}

/** Small data-loading hook: re-runs when deps change. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fn()
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}

export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
