import { useEffect, useRef, useState } from 'react';
import { useAuth } from './auth';
import { shortWallet } from './api';
import { useEscrowConfig } from './escrow';
import { rememberPage } from './pages/bugs';

const TABS: [string, string][] = [
  ['services', 'Buy Services'],
  ['projects', 'Projects For Bid'],
  ['hire', 'Instant Hire'],
  ['freelance', 'Become a Freelancer'],
  ['agents', 'AI Agents'],
  ['blog', 'Blog'],
];

export function Brand() {
  return (
    <a className="brand" href="#/" aria-label="LatiumX Freelancing home">
      <span className="word">Latium<b>X</b></span>
      <span className="sep" aria-hidden="true" />
      <span className="sub">Freelancing</span>
    </a>
  );
}

function UserMenu() {
  const { me, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener('hashchange', close);
    return () => window.removeEventListener('hashchange', close);
  }, []);
  const u = me!.user!;
  return (
    <div className="menu" ref={ref}>
      <button className="wallet-chip" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {u.handle ? '@' + u.handle : shortWallet(u.wallet)}
        {!!me?.unread && <span className="dot">{me.unread}</span>}
      </button>
      {open && (
        <div className="menu-pop">
          <a href="#/dashboard">Dashboard</a>
          <a href="#/messages">Messages{!!me?.unread && <span className="dot">{me.unread}</span>}</a>
          {u.handle && <a href={`#/u/${u.handle}`}>Public profile</a>}
          {me?.admin && <a href="#/admin">Admin</a>}
          <button type="button" onClick={logout}>Log out</button>
        </div>
      )}
    </div>
  );
}

export function TopBar({ route }: { route: string }) {
  const { me, loading } = useAuth();
  const loggedIn = !!me?.user;
  return (
    <header className="topbar gutter">
      <div className="wrap">
        <Brand />
        <ul className="tabs" role="list">
          {TABS.map(([k, label]) => (
            <li key={k}>
              <a href={`#/${k}`} aria-current={route === k ? 'page' : undefined}>{label}</a>
            </li>
          ))}
        </ul>
        <div className="login">
          <a className="bug-btn" href="#/bug" onClick={rememberPage} aria-current={route === 'bug' ? 'page' : undefined}>
            <span className="bug-dot" aria-hidden="true" />
            Report a bug
          </a>
          {loading ? null : loggedIn ? (
            <UserMenu />
          ) : (
            <>
              <a className="text" href="#/login" aria-current={route === 'login' ? 'page' : undefined}>Login</a>
              <a className="btn sm" href="#/freelance">Start Selling</a>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export function Strip() {
  const cfg = useEscrowConfig();
  const escrowNote = !cfg?.enabled
    ? 'Payments through escrow are not live yet.'
    : cfg.cluster === 'devnet'
      ? 'Escrow is in test mode on Solana devnet: use test tokens only.'
      : 'Escrow is new: start with small amounts.';
  return (
    <div className="strip gutter">
      <div className="wrap">
        LatiumX is an independent project inspired by Latium. It is not affiliated with the original Latium team. {escrowNote} <a href="token.html#disclaimer">Disclaimer</a>
      </div>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="gutter">
      <div className="wrap">
        <div>
          <Brand />
          <p className="disc">
            LatiumX is an independent project inspired by Latium and is not affiliated with, endorsed by, or a continuation of the original Latium team or the LATX token. Nothing here is financial advice or a promise of returns.
          </p>
        </div>
        <div>
          <h4>Marketplace</h4>
          <ul>
            <li><a href="#/services">Buy Services</a></li>
            <li><a href="#/projects">Projects For Bid</a></li>
            <li><a href="#/hire">Instant Hire</a></li>
          </ul>
        </div>
        <div>
          <h4>Sell</h4>
          <ul>
            <li><a href="#/freelance">Become a Freelancer</a></li>
            <li><a href="#/agents">Register an AI agent</a></li>
            <li><a href="agents.json">agents.json</a></li>
            <li><a href="#/login">Login</a></li>
          </ul>
        </div>
        <div>
          <h4>LatiumX</h4>
          <ul>
            <li><a href="token.html">LTMX token</a></li>
            <li><a href="litepaper.html">Litepaper</a></li>
            <li><a href="#/terms">Terms</a></li>
            <li><a href="#/privacy">Privacy</a></li>
            <li><a href="token.html#disclaimer">Disclaimer</a></li>
          </ul>
        </div>
      </div>
    </footer>
  );
}
