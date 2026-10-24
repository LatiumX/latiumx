// End-to-end escrow test: the real site (wrangler pages dev), the real compiled program (in
// LiteSVM behind a local RPC), and a real browser with simulated wallets that sign
// transactions. Nothing touches devnet or mainnet.
//
//   (cd ../.. && npm run build && cd programs/latiumx-escrow && cargo build-sbf)
//   npm install && npm test
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { chromium } = require('playwright');
const nacl = require('tweetnacl');
const kit = require('@solana/kit');
const { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } = require('@solana-program/token');
const { createChain, startRpc, toB58, fromB58 } = require('./rpc.cjs');

const APP = path.resolve(__dirname, '../..');
const PROGRAM_ID = 'G48Xix7oG6FL7hMArJgGyc5qtvjn3BX5BF21x3LYqGbN';
const RPC_PORT = 18899;
const WEB_PORT = 18788;
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const DAY = 86400;
const USDC = 1_000_000n;

let failures = 0;
const ok = (c, l) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`);
  if (!c) failures++;
};

const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const disc = (name) => require('crypto').createHash('sha256').update(name).digest().subarray(0, 8);
const pda = async (seeds) => (await kit.getProgramDerivedAddress({ programAddress: PROGRAM_ID, seeds }));

async function seed(chain, { client, freelancer, arbiter, fee }) {
  const { svm } = chain;
  svm.addProgram(PROGRAM_ID, fs.readFileSync(path.join(APP, 'target/deploy/latiumx_escrow.so')));
  for (const k of [client, freelancer, arbiter]) svm.airdrop(k, 10_000_000_000n);
  const rent = (n) => svm.minimumBalanceForRentExemption(BigInt(n));
  const put = (address, owner, data) => svm.setAccount({ address, programAddress: owner, data: Uint8Array.from(data), executable: false, lamports: rent(data.length), space: BigInt(data.length) });

  // A 6-decimal test token ("tUSDC") with no mint authority, and 1,000 of it for the client.
  const mint = toB58(nacl.sign.keyPair().publicKey);
  put(mint, TOKEN_PROGRAM_ADDRESS, Buffer.concat([Buffer.alloc(4), Buffer.alloc(32), u64(1000n * USDC), Buffer.from([6, 1]), Buffer.alloc(36)]));
  const [clientAta] = await findAssociatedTokenPda({ mint, owner: client, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  put(clientAta, TOKEN_PROGRAM_ADDRESS, Buffer.concat([fromB58(mint), fromB58(client), u64(1000n * USDC), Buffer.alloc(36), Buffer.from([1]), Buffer.alloc(12), u64(0), Buffer.alloc(36)]));

  // Config (2.5% fee) and the allow-list entry, written as the program would after setup.
  const [config, cBump] = await pda([Buffer.from('config')]);
  put(config, PROGRAM_ID, Buffer.concat([disc('account:Config'), fromB58(arbiter), Buffer.alloc(32), fromB58(arbiter), fromB58(fee), Buffer.from([250, 0, 0, cBump])]));
  const [allowed, aBump] = await pda([Buffer.from('mint'), fromB58(mint)]);
  put(allowed, PROGRAM_ID, Buffer.concat([disc('account:AllowedMint'), fromB58(mint), Buffer.from([1, aBump])]));
  return { mint };
}

async function tokenBalance(owner, mint) {
  const [ata] = await findAssociatedTokenPda({ mint, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const r = await rpc('getAccountInfo', [ata, { encoding: 'base64' }]);
  return r.value ? Buffer.from(r.value.data[0], 'base64').readBigUInt64LE(64) : 0n;
}
async function rpc(method, params) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

// ---------- simulated Wallet Standard wallet that can sign transactions ----------

function signWire(b64, kp) {
  const wire = Buffer.from(b64, 'base64');
  const readLen = (o) => {
    let len = 0, size = 0;
    for (;;) {
      const b = wire[o + size];
      len |= (b & 0x7f) << (7 * size);
      size++;
      if (!(b & 0x80)) return [len, size];
    }
  };
  const [nSigs, s1] = readLen(0);
  const msgStart = s1 + 64 * nSigs;
  const msg = wire.subarray(msgStart);
  const versioned = msg[0] & 0x80 ? 1 : 0;
  const required = msg[versioned];
  const [nKeys, s2] = readLen(msgStart + versioned + 3);
  const keysStart = msgStart + versioned + 3 + s2;
  const me = Buffer.from(kp.publicKey);
  for (let i = 0; i < Math.min(required, nKeys); i++) {
    if (wire.subarray(keysStart + 32 * i, keysStart + 32 * i + 32).equals(me)) {
      Buffer.from(nacl.sign.detached(msg, kp.secretKey)).copy(wire, s1 + 64 * i);
      return wire.toString('base64');
    }
  }
  throw new Error('wallet is not a signer of this transaction');
}

async function injectWallet(page, kp, name) {
  await page.exposeFunction('__lxSign', (b64) => Buffer.from(nacl.sign.detached(Buffer.from(b64, 'base64'), kp.secretKey)).toString('base64'));
  await page.exposeFunction('__lxSignTx', (b64) => signWire(b64, kp));
  await page.addInitScript(({ pub, name }) => {
    const pk = Uint8Array.from(atob(pub), (c) => c.charCodeAt(0));
    const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const toB58 = (bytes) => { let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of bytes) { if (b === 0) s = '1' + s; else break; } return s; };
    const chains = ['solana:mainnet', 'solana:devnet', 'solana:testnet', 'solana:localnet'];
    const account = { address: toB58(pk), publicKey: pk, chains, features: ['solana:signMessage', 'solana:signTransaction'] };
    const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
    let accounts = [];
    const listeners = [];
    const wallet = {
      version: '1.0.0', name, icon: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#8a1df2"/></svg>'),
      chains, get accounts() { return accounts; },
      features: {
        'standard:connect': { version: '1.0.0', connect: async () => { accounts = [account]; listeners.forEach((l) => l({ accounts })); return { accounts }; } },
        'standard:disconnect': { version: '1.0.0', disconnect: async () => { accounts = []; } },
        'standard:events': { version: '1.0.0', on: (e, l) => { listeners.push(l); return () => {}; } },
        'solana:signMessage': { version: '1.0.0', signMessage: async (...inputs) => Promise.all(inputs.map(async ({ message }) => {
          const sig = await window.__lxSign(b64(message));
          return { signedMessage: message, signature: Uint8Array.from(atob(sig), (c) => c.charCodeAt(0)) };
        })) },
        'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: async (...inputs) => Promise.all(inputs.map(async ({ transaction }) => {
          window.__lxSignCount = (window.__lxSignCount || 0) + 1;
          const signed = await window.__lxSignTx(b64(transaction));
          return { signedTransaction: Uint8Array.from(atob(signed), (c) => c.charCodeAt(0)) };
        })) },
      },
    };
    const register = (api) => api.register(wallet);
    window.addEventListener('wallet-standard:app-ready', (e) => register(e.detail));
    try { window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register })); } catch {}
  }, { pub: Buffer.from(kp.publicKey).toString('base64'), name });
}

async function login(page, walletName) {
  await page.goto(BASE + '/#/login');
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.locator('.wallet-adapter-modal').getByText(walletName).click();
  await page.locator('.wallet-chip').waitFor({ timeout: 15000 });
}

const call = (page, method, url, body) =>
  page.evaluate(async ({ method, url, body }) => {
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'latiumx' }, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${url}: ${data && data.error}`);
    return data;
  }, { method, url, body });


// ---------- run ----------

(async () => {
  const kps = { A: nacl.sign.keyPair(), B: nacl.sign.keyPair(), C: nacl.sign.keyPair(), F: nacl.sign.keyPair() };
  const addr = Object.fromEntries(Object.entries(kps).map(([k, v]) => [k, toB58(v.publicKey)]));
  const chain = createChain();
  const { mint } = await seed(chain, { client: addr.A, freelancer: addr.B, arbiter: addr.C, fee: addr.F });
  const rpcServer = startRpc(chain, RPC_PORT);

  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-e2e-'));
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'latiumx', '--local', '--persist-to', state], { cwd: APP, stdio: 'ignore', env: { ...process.env, CI: '1' } });
  const vars = {
    ADMIN_WALLETS: addr.C,
    ESCROW_PROGRAM_ID: PROGRAM_ID,
    SOLANA_CLUSTER: 'devnet',
    SOLANA_RPC: RPC,
    SOLANA_PUBLIC_RPC: RPC,
    ESCROW_MINTS: JSON.stringify([{ symbol: 'tUSDC', mint, decimals: 6 }]),
  };
  const web = spawn('npx', ['wrangler', 'pages', 'dev', 'dist', '--port', String(WEB_PORT), '--ip', '127.0.0.1', '--persist-to', state, ...Object.entries(vars).flatMap(([k, v]) => ['--binding', `${k}=${v}`])], { cwd: APP, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let webLog = '';
  web.stdout.on('data', (d) => (webLog += d));
  web.stderr.on('data', (d) => (webLog += d));
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(BASE + '/api/escrow/config')).ok) break;
    } catch {}
    if (i > 120) throw new Error('site did not start:\n' + webLog);
    await new Promise((r) => setTimeout(r, 500));
  }

  const browser = await chromium.launch();
  const errors = [];
  const pages = [];
  const open = async (who, name) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
    page.on('dialog', (d) => d.accept());
    await injectWallet(page, kps[who], name);
    await login(page, name);
    pages.push([who, page]);
    return page;
  };
  try {
    const cfg = await (await fetch(BASE + '/api/escrow/config')).json();
    ok(cfg.enabled && cfg.fee_bps === 250 && cfg.arbiter === addr.C, 'escrow config is read from the chain (fee 2.5%, arbiter)');

    const a = await open('A', 'Wallet A');
    const b = await open('B', 'Wallet B');
    const c = await open('C', 'Wallet C');
    const run = Math.random().toString(36).slice(2, 6);
    await call(a, 'PUT', '/api/me', { handle: `client-${run}`, display_name: 'Client', bio: '', country: '' });
    await call(b, 'PUT', '/api/me', { handle: `maker-${run}`, display_name: 'Freelancer', bio: '', country: '' });
    await call(c, 'PUT', '/api/me', { handle: `arbiter-${run}`, display_name: 'Arbiter', bio: '', country: '' });
    const { id: projectId } = await call(a, 'POST', '/api/projects', {
      title: 'Logo for a Solana community', description: 'Need a clean logo in SVG and PNG, two rounds of changes included.',
      category: 'design', budget_ltmx: 25, days: 7, agent_policy: 0, skills: ['logo'],
    });
    await call(b, 'POST', `/api/projects/${projectId}/bids`, { price_ltmx: 25, days: 5, note: 'I can deliver this in five days with two revisions.' });
    const proj = await call(a, 'GET', `/api/projects/${projectId}`);
    await call(a, 'POST', `/api/bids/${proj.bids[0].id}/accept`);

    // Escrows are found by address so older cards on the same page can't be mistaken for them.
    const seen = new Set();
    const fund = async (amount, days) => {
      await a.fill('#escrow-amount', amount);
      if (days) await a.fill('#escrow-days', days);
      await a.getByRole('button', { name: 'Fund escrow' }).click();
      for (let i = 0; i < 80; i++) {
        const fresh = (await a.locator('.item.escrow[data-state="funded"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-escrow')))).find((x) => !seen.has(x));
        if (fresh) {
          seen.add(fresh);
          return fresh;
        }
        await a.waitForTimeout(250);
      }
      throw new Error('funded escrow did not appear: ' + (await a.locator('.err').allInnerTexts()).join(' | '));
    };
    const esc = (page, address, state) => page.locator(`.item.escrow[data-escrow="${address}"]${state ? `[data-state="${state}"]` : ''}`);
    const act = async (page, address, from, button, to) => {
      await esc(page, address, from).getByRole('button', { name: button }).click();
      await esc(page, address, to).waitFor({ timeout: 20000 }).catch(async (e) => {
        throw new Error(`${button}: ${(await page.locator('.err').allInnerTexts()).join(' | ') || e.message}`);
      });
    };

    // 1. Client funds an escrow from the project page.
    await a.goto(`${BASE}/#/project/${projectId}`);
    await a.locator('#escrow-amount').waitFor();
    ok(await a.locator('.strip').innerText().then((t) => t.includes('devnet')), 'banner says escrow is in devnet test mode');
    await a.fill('#escrow-review', '3');
    const e1 = await fund('25', '7');
    ok(true, 'client funded the escrow and the page shows it as funded');
    ok((await tokenBalance(addr.A, mint)) === 975n * USDC, 'client paid 25 tUSDC into escrow (on-chain balance)');
    ok(!(await a.locator('#escrow-amount').count()), 'fund form is hidden while that escrow is live');
    ok(!(await esc(a, e1).getByRole('button', { name: 'Take money back' }).count()), 'no "Take money back" before the deadline');

    // 2. Freelancer marks it delivered from the dashboard.
    await b.goto(`${BASE}/#/dashboard/payments`);
    await act(b, e1, 'funded', 'Mark delivered', 'delivered');
    ok(true, 'freelancer marked the work delivered');
    ok(!(await esc(b, e1).getByRole('button', { name: 'Claim payment' }).count()), 'freelancer cannot claim during the review period');

    // 3. Client releases payment.
    await a.reload();
    await act(a, e1, 'delivered', 'Release payment', 'released');
    ok((await tokenBalance(addr.B, mint)) === 24_375_000n, 'freelancer received 24.375 tUSDC (25 minus 2.5% fee)');
    ok((await tokenBalance(addr.F, mint)) === 625_000n, 'fee wallet received 0.625 tUSDC');
    ok(!(await rpc('getAccountInfo', [e1, { encoding: 'base64' }])).value, 'escrow account is closed on-chain');
    ok(await esc(a, e1).innerText().then((t) => t.includes('Freelancer got 24.375 tUSDC')), 'page shows the payout read from the chain');

    // 4. Second escrow goes to dispute and the arbiter splits it 60/40.
    const e2 = await fund('10');
    await b.reload();
    await act(b, e2, 'funded', 'Open dispute', 'disputed');
    ok(!(await esc(b, e2).getByRole('button', { name: 'Refund client' }).count()), 'no refund or release buttons while disputed');
    await c.goto(`${BASE}/#/admin`);
    await esc(c, e2, 'disputed').waitFor({ timeout: 15000 });
    await esc(c, e2).locator('input[type="range"]').fill('60');
    await esc(c, e2).getByRole('button', { name: 'Resolve dispute' }).click();
    await esc(c, e2).waitFor({ state: 'detached', timeout: 20000 });
    ok((await tokenBalance(addr.B, mint)) === 24_375_000n + 5_850_000n, 'arbiter split: freelancer got 6 minus fee');
    ok((await tokenBalance(addr.A, mint)) === 969n * USDC, 'arbiter split: client got 4 back');

    const bogus = await b.evaluate(async () => (await fetch('/api/escrows/sync', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'latiumx' }, body: JSON.stringify({ address: '11111111111111111111111111111111', signature: '' }) })).status);
    ok(bogus === 400 || bogus === 404, 'sync rejects accounts that are not escrows');

    // 5. Missed deadline: fund with the chain clock 8 days in the past, then the client takes it back.
    await rpc('lx_setOffset', [-8 * DAY]);
    await a.reload();
    const e3 = await fund('5', '1');
    await rpc('lx_setOffset', [0]);
    await a.reload();
    await act(a, e3, 'funded', 'Take money back', 'refunded');
    ok((await tokenBalance(addr.A, mint)) === 969n * USDC, 'client reclaimed 5 tUSDC after the missed deadline');

    // 6. Silent client: delivered 4 days ago with a 3-day review, freelancer claims.
    await rpc('lx_setOffset', [-4 * DAY]);
    await a.reload();
    const e4 = await fund('2', '7');
    await b.reload();
    await act(b, e4, 'funded', 'Mark delivered', 'delivered');
    await rpc('lx_setOffset', [0]);
    await b.reload();
    await act(b, e4, 'delivered', 'Claim payment', 'released');
    ok((await tokenBalance(addr.B, mint)) === 24_375_000n + 5_850_000n + 1_950_000n, 'freelancer claimed after the review period');

    // 7. Freelancer refunds a fresh escrow in full.
    await a.reload();
    const e5 = await fund('3');
    await b.reload();
    await act(b, e5, 'funded', 'Refund client', 'refunded');
    ok((await tokenBalance(addr.A, mint)) === 967n * USDC, 'freelancer refunded 3 tUSDC in full');

    // 8. The client's dashboard lists all five escrows with the right final states.
    await a.goto(`${BASE}/#/dashboard/payments`);
    await a.locator('.item.escrow').first().waitFor();
    const states = await a.locator('.item.escrow').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')).sort());
    ok(JSON.stringify(states) === JSON.stringify(['refunded', 'refunded', 'released', 'released', 'resolved']), `dashboard shows all escrows (${states.join(', ')})`);

    // 9. Phone width: no sideways scrolling on the payments page.
    await a.setViewportSize({ width: 390, height: 800 });
    ok(await a.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'payments page fits a 390px phone screen');
    await a.screenshot({ path: path.join(process.env.SHOTS || os.tmpdir(), 'escrow-payments-phone.png'), fullPage: true });
    await a.setViewportSize({ width: 1280, height: 900 });
    await a.goto(`${BASE}/#/project/${projectId}`);
    await a.locator('#escrow-amount').waitFor();
    await a.screenshot({ path: path.join(process.env.SHOTS || os.tmpdir(), 'escrow-project.png'), fullPage: true });

    ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  } catch (e) {
    failures++;
    console.log('FAIL  ' + (e.stack || e));
    for (const [who, p] of pages) {
      const notes = await p.locator('.err').allInnerTexts().catch(() => []);
      if (notes.length) console.log(`  ${who} sees: ${notes.join(' | ')}`);
    }
    if (process.env.DEBUG) console.log(webLog.slice(-4000));
  } finally {
    await browser.close();
    try {
      process.kill(-web.pid, 'SIGTERM');
    } catch {}
    rpcServer.close();
    fs.rmSync(state, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
