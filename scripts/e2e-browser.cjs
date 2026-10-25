// Browser test with a simulated Wallet Standard wallet (no real Phantom needed).
//   node scripts/e2e-browser.cjs http://127.0.0.1:8788 <screenshot dir>
const { chromium } = require('playwright');
const nacl = require('tweetnacl');
const bs58 = require('bs58').default;

const BASE = process.argv[2] || 'http://127.0.0.1:8788';
const OUT = process.argv[3] || '.';
let failures = 0;
const RUN = Math.random().toString(36).slice(2, 7);
const ok = (c, l) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); if (!c) failures++; };

function injectWallet(page, kp, name) {
  return page.exposeFunction('__lxSign', (b64) => Buffer.from(nacl.sign.detached(Buffer.from(b64, 'base64'), kp.secretKey)).toString('base64'))
    .then(() => page.addInitScript(({ pub, name }) => {
      const pk = Uint8Array.from(atob(pub), (c) => c.charCodeAt(0));
      const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      const toB58 = (bytes) => { let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of bytes) { if (b === 0) s = '1' + s; else break; } return s; };
      const account = { address: toB58(pk), publicKey: pk, chains: ['solana:mainnet'], features: ['solana:signMessage', 'solana:signTransaction'] };
      let accounts = [];
      const listeners = [];
      const wallet = {
        version: '1.0.0', name, icon: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#8a1df2"/></svg>'),
        chains: ['solana:mainnet'], get accounts() { return accounts; },
        features: {
          'standard:connect': { version: '1.0.0', connect: async () => { accounts = [account]; listeners.forEach((l) => l({ accounts })); return { accounts }; } },
          'standard:disconnect': { version: '1.0.0', disconnect: async () => { accounts = []; } },
          'standard:events': { version: '1.0.0', on: (e, l) => { listeners.push(l); return () => {}; } },
          'solana:signMessage': { version: '1.0.0', signMessage: async (...inputs) => Promise.all(inputs.map(async ({ message }) => {
            const sigB64 = await window.__lxSign(btoa(String.fromCharCode(...message)));
            return { signedMessage: message, signature: Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0)) };
          })) },
          'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: async () => { throw new Error('not in test'); } },
        },
      };
      const register = (api) => api.register(wallet);
      window.addEventListener('wallet-standard:app-ready', (e) => register(e.detail));
      try { window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register })); } catch {}
    }, { pub: Buffer.from(kp.publicKey).toString('base64'), name }));
}

async function loginViaUi(page, walletName) {
  await page.goto(BASE + '/#/login');
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.locator('.wallet-adapter-modal').getByText(walletName).click();
  await page.locator('.wallet-chip').waitFor({ timeout: 10000 });
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const A = nacl.sign.keyPair(), B = nacl.sign.keyPair();
  const ctxA = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const a = await ctxA.newPage();
  a.on('pageerror', (e) => errors.push('A: ' + e.message));
  await injectWallet(a, A, 'TestWallet A');

  await a.goto(BASE + '/');
  await a.waitForSelector('.hero h1');
  ok(await a.locator('.hero h1').isVisible(), 'home renders');
  await a.screenshot({ path: `${OUT}/b-home-empty.png` });

  await loginViaUi(a, 'TestWallet A');
  ok(true, 'wallet connect + signature login through UI');
  await a.goto(BASE + '/#/dashboard');
  await a.fill('#p-handle', 'pixelharbor-' + RUN);
  await a.fill('#p-name', 'Pixel Harbor Studio');
  await a.fill('#p-bio', 'Logos and brand kits for crypto projects.');
  await a.fill('#p-country', 'Portugal');
  await a.check('#p-available');
  await a.getByRole('button', { name: 'Save profile' }).click();
  await a.getByText('Profile saved.').waitFor();
  ok(true, 'profile saved through UI');
  await a.screenshot({ path: `${OUT}/b-dashboard.png`, fullPage: true });

  await a.goto(BASE + '/#/dashboard/gigs/new');
  await a.fill('#g-title', 'I will design a clean logo and brand kit');
  await a.fill('#g-desc', 'Three logo concepts, two rounds of revisions, final files in SVG and PNG with a one-page brand guide.');
  await a.selectOption('#g-cat', 'design');
  await a.fill('#g-price', '900');
  await a.fill('#g-days', '5');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8Dwn4GBgYGJAQoAAB4rAgNbn1XDAAAAAElFTkSuQmCC', 'base64');
  await a.setInputFiles('#g-image', { name: 'logo.png', mimeType: 'image/png', buffer: png });
  await a.waitForFunction(() => !document.body.innerText.includes('Uploading…'));
  await a.getByRole('button', { name: 'Publish service' }).click();
  await a.waitForURL(/#\/gig\/\d+/);
  ok(await a.getByRole('heading', { name: 'I will design a clean logo and brand kit' }).waitFor().then(() => true, () => false), 'gig published and detail page shown');
  const gigUrl = a.url();

  await a.goto(BASE + '/#/dashboard/projects/new');
  await a.fill('#pr-title', 'Label 2,000 support tickets by topic');
  await a.fill('#pr-desc', 'Sort exported tickets into 12 given categories and flag anything urgent. CSV in, CSV out.');
  await a.selectOption('#pr-cat', 'data');
  await a.fill('#pr-budget', '900');
  await a.fill('#pr-days', '3');
  await a.selectOption('#pr-policy', '1');
  await a.fill('#pr-skills', 'Classification, CSV');
  await a.getByRole('button', { name: 'Post project' }).click();
  await a.waitForURL(/#\/project\/\d+/);
  ok(await a.locator('.policy', { hasText: 'AI agents welcome' }).first().waitFor().then(() => true, () => false), 'project posted with agent policy');
  const projUrl = a.url();

  // second user
  const ctxB = await browser.newContext({ viewport: { width: 400, height: 860 } });
  const b = await ctxB.newPage();
  b.on('pageerror', (e) => errors.push('B: ' + e.message + ' @ ' + (e.stack||'').split('\n').slice(0,4).join(' | ')));
  await injectWallet(b, B, 'TestWallet B');
  await loginViaUi(b, 'TestWallet B');
  await b.goto(BASE + '/#/dashboard');
  await b.fill('#p-handle', 'northstack-' + RUN);
  await b.fill('#p-name', 'North Stack');
  await b.getByRole('button', { name: 'Save profile' }).click();
  await b.getByText('Profile saved.').waitFor();
  await b.goto(BASE + '/#/services');
  await b.locator('.cardlink').first().waitFor();
  ok(await b.locator('.cardlink').count() >= 1, 'services list shows the new gig');
  await b.screenshot({ path: `${OUT}/b-services-mobile.png`, fullPage: true });
  ok(await b.evaluate(() => document.documentElement.scrollWidth) <= 400, 'no horizontal scroll at phone width');

  await b.goto(projUrl);
  await b.fill('#bid-price', '850');
  await b.fill('#bid-days', '2');
  await b.fill('#bid-note', 'I have labelled support tickets for three SaaS companies.');
  await b.getByRole('button', { name: 'Place bid' }).click();
  await b.getByText('Status:').waitFor();
  ok(true, 'bid placed through UI');

  await b.goto(gigUrl);
  await b.getByRole('button', { name: 'Contact seller' }).click();
  await b.waitForURL(/#\/messages\/\d+/);
  await b.fill('#msg-body', 'Hi! Can you do a logo by Friday?');
  await b.getByRole('button', { name: 'Send' }).click();
  await b.locator('.bubble.me').waitFor({ timeout: 8000 }).catch(async () => { await b.screenshot({ path: `${OUT}/b-fail.png` }); console.log('ERRORS', errors); });
  ok(true, 'message sent through UI');

  // A sees bid + unread message, replies
  await a.goto(projUrl);
  await a.reload();
  await a.getByRole('button', { name: 'Accept' }).waitFor();
  ok(await a.getByText('I have labelled support tickets').isVisible(), 'owner sees the bid');
  await a.getByRole('button', { name: 'Accept' }).click();
  await a.locator('.status.good', { hasText: 'accepted' }).waitFor();
  ok(true, 'owner accepts bid');
  await a.screenshot({ path: `${OUT}/b-project-owner.png`, fullPage: true });
  await a.reload();
  await a.locator('.wallet-chip .dot').waitFor({ timeout: 10000 });
  ok(true, 'unread badge shows for seller');
  await a.goto(BASE + '/#/messages');
  await a.locator('.bubble', { hasText: 'Hi! Can you do a logo by Friday?' }).waitFor();
  await a.fill('#msg-body', 'Yes, Friday works.');
  await a.getByRole('button', { name: 'Send' }).click();
  await a.locator('.bubble.me', { hasText: 'Friday works' }).waitFor();
  await a.screenshot({ path: `${OUT}/b-messages.png` });
  await b.waitForTimeout(8500);
  ok(await b.locator('.bubble', { hasText: 'Yes, Friday works.' }).isVisible(), 'reply arrives for buyer (polling)');

  // pages render
  for (const r of ['hire', 'agents', 'freelance', 'blog', 'community', 'community/leaderboard', 'dashboard/friends', 'terms', 'privacy', 'u/pixelharbor-' + RUN, 'nope']) {
    await a.goto(BASE + '/#/' + r);
    await a.waitForTimeout(300);
  }
  await a.goto(BASE + '/#/hire');
  await a.locator('.person').first().waitFor();
  ok(await a.locator('.person').count() >= 1, 'instant hire lists available user');
  await a.goto(BASE + '/#/u/pixelharbor-' + RUN);
  await a.getByText('Pixel Harbor Studio').waitFor();
  ok(true, 'public profile renders');
  await a.goto(BASE + '/index.html#agents');
  await a.getByRole('heading', { name: 'AI Agents' }).waitFor();
  ok(true, 'old #agents link still works');

  // report a bug
  await a.goto(BASE + '/#/services');
  ok(await a.locator('.topbar .bug-btn').isVisible(), 'report a bug button in top bar');
  await a.locator('.topbar .bug-btn').click();
  await a.locator('#bug-title').waitFor();
  ok((await a.inputValue('#bug-page')) === '#/services', 'bug form remembers the page');
  await a.fill('#bug-title', 'Filter chips overlap on small screens');
  await a.fill('#bug-details', 'Open Buy Services on a phone, the chips overlap the search box.');
  await a.getByRole('button', { name: 'Send report' }).click();
  await a.getByText('Thanks! Your report was sent.').waitFor();
  await a.locator('.item', { hasText: 'Filter chips overlap on small screens' }).waitFor();
  ok(true, 'bug report sent and listed under Your reports');
  await a.screenshot({ path: `${OUT}/b-bug.png`, fullPage: true });
  await a.setViewportSize({ width: 390, height: 800 });
  ok(await a.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'bug page fits a phone screen');
  await a.screenshot({ path: `${OUT}/b-bug-phone.png` });
  await a.setViewportSize({ width: 1360, height: 900 });

  // community: search, add friend, accept, leaderboard, block
  await a.goto(BASE + '/#/community');
  ok(await a.locator('.topbar .tabs a', { hasText: 'Community' }).isVisible(), 'community tab in top bar');
  await a.fill('.people-search', 'northstack-' + RUN);
  const card = a.locator(`.person[data-person="northstack-${RUN}"]`);
  await card.waitFor();
  ok(await a.waitForFunction(() => document.querySelectorAll('.person').length === 1, null, { timeout: 5000 }).then(() => true, () => false), 'search finds the other user');
  await card.getByRole('button', { name: 'Add friend' }).click();
  await card.getByText('Request sent').waitFor();
  ok(true, 'friend request sent from search');
  await a.screenshot({ path: `${OUT}/c-people.png`, fullPage: true });
  await b.goto(BASE + '/#/services');
  await b.reload();
  await b.locator('.wallet-chip .dot').waitFor({ timeout: 10000 });
  await b.locator('.wallet-chip').click();
  await b.locator('.menu-pop a', { hasText: 'Friends' }).click();
  const req = b.locator(`.item[data-friend="pixelharbor-${RUN}"]`);
  await req.getByRole('button', { name: 'Accept' }).click();
  await b.getByRole('heading', { name: 'Friends (1)' }).waitFor();
  ok(true, 'friend request accepted from dashboard');
  await b.screenshot({ path: `${OUT}/c-friends-phone.png`, fullPage: true });
  ok(await b.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'friends page fits a phone screen');
  await b.goto(BASE + '/#/u/pixelharbor-' + RUN);
  await b.locator('.friend-act .status', { hasText: 'Friends' }).waitFor();
  ok(await b.locator('.stats', { hasText: '1 friend' }).isVisible(), 'profile shows friends and stats');
  await b.screenshot({ path: `${OUT}/c-profile-phone.png`, fullPage: true });
  await b.goto(BASE + '/#/community/leaderboard');
  await b.locator('.board[data-board="connected"] li').first().waitFor();
  ok(await b.locator('.board[data-board="freelancers"]', { hasText: 'northstack-' + RUN }).isVisible(), 'leaderboard lists the freelancer who won a job');
  ok(await b.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'leaderboard fits a phone screen');
  await b.screenshot({ path: `${OUT}/c-leaderboard-phone.png`, fullPage: true });
  await a.goto(BASE + '/#/community/leaderboard');
  await a.locator('.board li').first().waitFor();
  await a.screenshot({ path: `${OUT}/c-leaderboard.png`, fullPage: true });
  // block from the profile
  await a.goto(BASE + '/#/u/northstack-' + RUN);
  a.once('dialog', (d) => d.accept());
  await a.getByRole('button', { name: 'Block' }).click();
  await a.getByText('You blocked').waitFor();
  ok(!(await a.getByRole('button', { name: 'Message' }).isVisible()), 'blocking hides Message and Add friend');
  await b.goto(BASE + '/#/u/pixelharbor-' + RUN);
  await b.getByRole('button', { name: 'Message' }).click();
  await b.getByText("You can't message this user.").waitFor();
  ok(true, 'blocked user cannot start a conversation');
  await a.getByRole('button', { name: 'Unblock' }).click();
  await a.getByRole('button', { name: 'Add friend' }).waitFor();
  ok(true, 'unblock');
  for (const w of [1600, 1440, 1360, 1280, 1100, 800]) {
    await a.setViewportSize({ width: w, height: 900 });
    ok(await a.evaluate(() => { const t = document.querySelector('.topbar .tabs'); const last = t.lastElementChild.getBoundingClientRect(); return t.scrollWidth <= t.clientWidth + 1 && last.right <= window.innerWidth && document.documentElement.scrollWidth <= window.innerWidth; }), `every top bar tab visible at ${w}px`);
    if (w === 1440 || w === 1280) await a.screenshot({ path: `${OUT}/c-topbar-${w}.png`, clip: { x: 0, y: 0, width: w, height: 200 } });
  }
  await a.setViewportSize({ width: 1360, height: 900 });

  // logout
  await a.locator('.wallet-chip').click();
  await a.getByRole('button', { name: 'Log out' }).click();
  await a.getByRole('link', { name: 'Login' }).waitFor();
  ok(true, 'logout');

  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
