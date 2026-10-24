import { useRef, useState, type FormEvent } from 'react';
import { PublicKey, type Connection, type Transaction } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { api, ago, shortWallet } from '../api';
import { useAuth } from '../auth';
import { Empty, ErrorNote, useLoad } from '../ui';
import { formatUnits, parseUnits, REF_KIND } from '../../shared/escrow-layout';
import { buildAction, buildCreate, sendAndSync, useEscrowConfig, type EscrowAction, type EscrowConfig, type EscrowRow } from '../escrow';

type LiveConfig = Extract<EscrowConfig, { enabled: true }>;

/** The connected wallet, checked against the logged-in account, plus a send function. */
function useSigner() {
  const wallet = useWallet();
  // ensureWallet() resolves after a re-render, so read the wallet from the latest render.
  const latest = useRef(wallet);
  latest.current = wallet;
  const { me, ensureWallet } = useAuth();
  return {
    async require(): Promise<PublicKey> {
      const mine = me?.user?.wallet;
      const pk = await ensureWallet();
      if (pk.toBase58() !== mine) throw new Error(`Switch your wallet to the account you logged in with (${shortWallet(mine || '')}).`);
      return pk;
    },
    send: (tx: Transaction, conn: Connection) => latest.current.sendTransaction(tx, conn),
  };
}

const mintInfo = (cfg: LiveConfig, mint: string) => cfg.mints.find((m) => m.mint === mint);
export const showAmount = (cfg: LiveConfig, mint: string, raw: string | bigint) => {
  const m = mintInfo(cfg, mint);
  return m ? `${formatUnits(raw, m.decimals)} ${m.symbol}` : `${raw.toString()} units of ${shortWallet(mint)}`;
};
const explorer = (cfg: LiveConfig, kind: 'tx' | 'address', id: string) =>
  `https://explorer.solana.com/${kind}/${id}${cfg.cluster === 'devnet' ? '?cluster=devnet' : ''}`;
const days = (s: number) => Math.round(s / 86400);
const dateOf = (ts: number) => new Date(ts * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function EscrowOffNote() {
  return <p className="muted">Escrow payments are not live yet. Agree payment directly with the other person for now, and be careful.</p>;
}

// ---------- funding ----------

export function FundEscrow({ projectId, freelancer, suggested, suggestedDays, onDone }: {
  projectId: number;
  freelancer: string;
  suggested: number;
  suggestedDays: number;
  onDone: () => void;
}) {
  const cfg = useEscrowConfig();
  const signer = useSigner();
  const [mint, setMint] = useState('');
  const [amount, setAmount] = useState(String(suggested));
  const [delivery, setDelivery] = useState(String(Math.min(365, Math.max(1, suggestedDays))));
  const [review, setReview] = useState('3');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!cfg) return null;
  if (!cfg.enabled) return <EscrowOffNote />;
  if (!cfg.mints.length) return <p className="muted">No tokens are set up for escrow yet.</p>;
  const token = mintInfo(cfg, mint) || cfg.mints[0];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    const raw = parseUnits(amount, token.decimals);
    const d = Number(delivery);
    const r = Number(review);
    if (!raw) return setErr('Enter an amount above zero.');
    if (!Number.isInteger(d) || d < 1 || d > 365) return setErr('Delivery time must be 1 to 365 days.');
    if (!Number.isInteger(r) || r < 1 || r > 30) return setErr('Review period must be 1 to 30 days.');
    setBusy(true);
    try {
      const client = await signer.require();
      const { tx, escrow } = await buildCreate(cfg, {
        client,
        freelancer: new PublicKey(freelancer),
        mint: new PublicKey(token.mint),
        amount: raw,
        deliveryDays: d,
        reviewDays: r,
        refKind: REF_KIND.project,
        refId: projectId,
      });
      await sendAndSync(cfg, signer.send, tx, escrow);
      onDone();
    } catch (er: any) {
      setErr(er.message);
    } finally {
      setBusy(false);
    }
  };

  const fee = cfg.fee_bps ?? 0;
  return (
    <form className="form escrow-form" onSubmit={submit}>
      <div className="row2">
        <label className="field">Amount
          <input id="escrow-amount" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="field">Token
          <select id="escrow-token" value={token.mint} onChange={(e) => setMint(e.target.value)}>
            {cfg.mints.map((m) => <option key={m.mint} value={m.mint}>{m.symbol}</option>)}
          </select>
        </label>
      </div>
      <div className="row2">
        <label className="field">Delivery deadline (days)<input id="escrow-days" type="number" min={1} max={365} required value={delivery} onChange={(e) => setDelivery(e.target.value)} /></label>
        <label className="field">Review period (days)<input id="escrow-review" type="number" min={1} max={30} required value={review} onChange={(e) => setReview(e.target.value)} /></label>
      </div>
      <p className="muted">
        The amount is locked on Solana until you release it. If the freelancer marks the work delivered and you don't respond within the review period,
        they can claim it. If they don't deliver by the deadline, you can take it back. Either of you can open a dispute.
        {fee > 0 ? ` A ${fee / 100}% platform fee comes out of the freelancer's payment.` : ' No platform fee.'}
        {cfg.cluster === 'devnet' && ' This is the Solana devnet: test tokens only.'}
      </p>
      <ErrorNote error={err} />
      <button className="btn" type="submit" disabled={busy || cfg.paused === true}>{busy ? 'Confirm in your wallet…' : 'Fund escrow'}</button>
      {cfg.paused && <p className="err">New escrows are paused right now.</p>}
    </form>
  );
}

// ---------- one escrow ----------

const STATE_LABEL: Record<EscrowRow['state'], string> = {
  funded: 'Funded, waiting for delivery',
  delivered: 'Delivered, waiting for the client',
  disputed: 'In dispute',
  released: 'Paid to freelancer',
  refunded: 'Refunded to client',
  resolved: 'Settled by arbiter',
};

export function EscrowCard({ row, cfg, onChange, arbiter }: { row: EscrowRow; cfg: LiveConfig; onChange: () => void; arbiter?: boolean }) {
  const { me } = useAuth();
  const signer = useSigner();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [split, setSplit] = useState(50);
  const wallet = me?.user?.wallet;
  const isClient = wallet === row.client.wallet;
  const isFreelancer = wallet === row.freelancer.wallet;
  const t = Math.floor(Date.now() / 1000);
  const claimAt = row.delivered_at + row.review_seconds;
  const live = row.state === 'funded' || row.state === 'delivered' || row.state === 'disputed';

  const run = async (action: EscrowAction, bps?: number) => {
    setErr(null);
    setBusy(action);
    try {
      const tx = await buildAction(cfg, action, row.address, await signer.require(), bps);
      await sendAndSync(cfg, signer.send, tx, row.address);
      onChange();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };
  const refresh = async () => {
    setErr(null);
    setBusy('refresh');
    try {
      await api('/api/escrows/sync', { body: { address: row.address, signature: '' } });
      onChange();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };
  const btn = (action: EscrowAction, label: string, cls = 'btn sm', confirmText?: string) => (
    <button className={cls} type="button" disabled={!!busy} onClick={() => (!confirmText || confirm(confirmText)) && run(action)}>
      {busy === action ? 'Confirm in wallet…' : label}
    </button>
  );
  const who = (u: { wallet: string; handle: string | null }) => (u.handle ? <a href={`#/u/${u.handle}`}>@{u.handle}</a> : shortWallet(u.wallet));
  const o = row.outcome;

  return (
    <div className="item escrow" data-escrow={row.address} data-state={row.state}>
      <div style={{ display: 'grid', gap: 6, flex: '1 1 320px' }}>
        <b>{showAmount(cfg, row.mint, row.amount)}</b>
        <span className="muted">
          {who(row.client)} → {who(row.freelancer)}
          {row.ref.kind === REF_KIND.project && <> · <a href={`#/project/${row.ref.id}`}>{row.ref.title || `Project #${row.ref.id}`}</a></>}
        </span>
        <span className={`status${row.state === 'released' ? ' good' : row.state === 'disputed' ? ' bad' : ''}`}>{STATE_LABEL[row.state]}</span>
        <span className="muted">
          Funded {ago(row.created_at)}
          {row.state === 'funded' && <> · delivery due {dateOf(row.delivery_deadline)}</>}
          {row.state === 'delivered' && <> · client review ends {dateOf(claimAt)}</>}
          {row.fee_bps > 0 && <> · fee {row.fee_bps / 100}%</>}
        </span>
        {o && 'to_freelancer' in o && <span className="muted">Freelancer got {showAmount(cfg, row.mint, String(o.to_freelancer))}{o.fee && o.fee !== '0' ? `, fee ${showAmount(cfg, row.mint, String(o.fee))}` : ''}{'to_client' in o ? `, client got ${showAmount(cfg, row.mint, String(o.to_client))}` : ''}.</span>}
        {o && !('to_freelancer' in o) && 'to_client' in o && <span className="muted">Client got {showAmount(cfg, row.mint, String(o.to_client))} back.</span>}
        <span className="muted">
          <a href={explorer(cfg, 'address', row.address)} target="_blank" rel="noreferrer">View on Solana Explorer</a>
          {row.last_signature && <> · <a href={explorer(cfg, 'tx', row.last_signature)} target="_blank" rel="noreferrer">last transaction</a></>}
        </span>
        <ErrorNote error={err} />
      </div>
      {live && (
        <div className="actions" style={{ alignSelf: 'center' }}>
          {isClient && row.state !== 'disputed' && btn('release', 'Release payment', 'btn sm', 'Pay the freelancer now? This cannot be undone.')}
          {isClient && row.state === 'funded' && t > row.delivery_deadline && btn('reclaim', 'Take money back', 'btn ghost sm')}
          {isFreelancer && row.state === 'funded' && btn('deliver', 'Mark delivered')}
          {isFreelancer && row.state === 'delivered' && t >= claimAt && btn('claim', 'Claim payment')}
          {isFreelancer && row.state !== 'disputed' && btn('refund', 'Refund client', 'btn ghost sm', 'Give the whole amount back to the client? This cannot be undone.')}
          {(isClient || isFreelancer) && row.state !== 'disputed' && btn('dispute', 'Open dispute', 'linkbtn', 'Open a dispute? The money stays locked until the LatiumX arbiter decides the split.')}
          {arbiter && row.state === 'disputed' && (
            <div className="split">
              <label className="field">Freelancer gets {split}%
                <input type="range" min={0} max={100} step={5} value={split} onChange={(e) => setSplit(Number(e.target.value))} />
              </label>
              <button className="btn sm" type="button" disabled={!!busy}
                onClick={() => confirm(`Pay ${split}% to the freelancer and ${100 - split}% back to the client? This cannot be undone.`) && run('resolve', split * 100)}>
                {busy === 'resolve' ? 'Confirm in wallet…' : 'Resolve dispute'}
              </button>
            </div>
          )}
          <button className="linkbtn" type="button" disabled={!!busy} onClick={refresh}>{busy === 'refresh' ? 'Checking…' : 'Refresh'}</button>
        </div>
      )}
    </div>
  );
}

export function EscrowList({ rows, onChange, arbiter }: { rows: EscrowRow[]; onChange: () => void; arbiter?: boolean }) {
  const cfg = useEscrowConfig();
  if (!cfg?.enabled) return null;
  return <div className="list">{rows.map((r) => <EscrowCard key={r.address} row={r} cfg={cfg} onChange={onChange} arbiter={arbiter} />)}</div>;
}

// ---------- dashboard and admin ----------

export function MyPayments() {
  const cfg = useEscrowConfig();
  const { data, error, loading, reload } = useLoad(() => api<{ escrows: EscrowRow[] }>('/api/me/escrows'), []);
  if (!cfg) return null;
  if (!cfg.enabled) return <EscrowOffNote />;
  return (
    <>
      <p className="muted">Escrows you funded as a client or are being paid through as a freelancer. Money moves only when you or the other person sign in your wallets.</p>
      <ErrorNote error={error} />
      {loading && !data ? <p className="loading">Loading…</p> : data?.escrows.length ? <EscrowList rows={data.escrows} onChange={reload} /> : <Empty>No escrow payments yet. Fund one from a project after you accept a bid.</Empty>}
    </>
  );
}

export function AdminDisputes() {
  const cfg = useEscrowConfig();
  const { me } = useAuth();
  const [state, setState] = useState('disputed');
  const { data, error, reload } = useLoad(
    () => (cfg?.enabled ? api<{ escrows: EscrowRow[] }>(`/api/admin/escrows?state=${state}`) : Promise.resolve({ escrows: [] })),
    [state, cfg?.enabled],
  );
  if (!cfg?.enabled) return null;
  const isArbiter = !!cfg.arbiter && cfg.arbiter === me?.user?.wallet;
  return (
    <div className="section" style={{ paddingTop: 12 }}>
      <h2>Escrow disputes</h2>
      <p className="muted">
        {isArbiter ? 'You are the arbiter. Read both sides in the project messages before you decide.' : `Only the arbiter wallet (${cfg.arbiter ? shortWallet(cfg.arbiter) : 'not set up yet'}) can resolve disputes.`}
      </p>
      <div className="tabsbar">
        {['disputed', 'funded', 'delivered', 'resolved'].map((s) => (
          <button key={s} type="button" aria-pressed={state === s} onClick={() => setState(s)}>{s}</button>
        ))}
      </div>
      <ErrorNote error={error} />
      {data?.escrows.length ? <EscrowList rows={data.escrows} onChange={reload} arbiter={isArbiter} /> : <Empty>No {state} escrows.</Empty>}
    </div>
  );
}
