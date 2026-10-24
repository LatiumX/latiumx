// End-to-end API check against a running local server:
//   npx wrangler pages dev dist --port 8788 --binding ADMIN_WALLETS=<wallet>   (see test instructions in README)
//   node scripts/e2e-api.mjs http://127.0.0.1:8788
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const BASE = process.argv[2] || 'http://127.0.0.1:8788';
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failures++; };

function wallet() {
  const kp = nacl.sign.keyPair();
  return { kp, address: bs58.encode(kp.publicKey), token: null };
}

async function call(w, method, path, body, extraHeaders = {}) {
  const headers = { 'x-requested-with': 'latiumx', ...extraHeaders };
  if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = 'application/json';
  if (w?.token) headers.authorization = `Bearer ${w.token}`;
  const res = await fetch(BASE + path, { method, headers, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, data, headers: res.headers };
}

async function login(w) {
  const n = await call(null, 'POST', '/api/auth/nonce', { wallet: w.address });
  const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(n.data.message), w.kp.secretKey));
  const v = await call(null, 'POST', '/api/auth/verify', { wallet: w.address, nonce: n.data.nonce, signature: sig });
  w.token = v.data.token;
  return { n, v };
}

const alice = wallet(), bob = wallet(), bot = wallet(), mallory = wallet();
const admin = { ...wallet(), ...(process.env.ADMIN_SECRET ? {} : {}) };

// auth
const { n, v } = await login(alice);
ok(n.data.message.includes(alice.address) && n.data.message.includes('costs nothing'), 'nonce message names the wallet and says it is free');
ok(v.status === 200 && v.data.token && /lx_session=/.test(v.headers.get('set-cookie') || ''), 'verify returns token and session cookie');
const replay = await call(null, 'POST', '/api/auth/verify', { wallet: alice.address, nonce: n.data.nonce, signature: 'x'.repeat(88) });
ok(replay.status === 400, 'nonce cannot be reused');
const n2 = await call(null, 'POST', '/api/auth/nonce', { wallet: mallory.address });
const forged = bs58.encode(nacl.sign.detached(new TextEncoder().encode(n2.data.message), alice.kp.secretKey));
ok((await call(null, 'POST', '/api/auth/verify', { wallet: mallory.address, nonce: n2.data.nonce, signature: forged })).status === 401, 'signature from another wallet is rejected');
ok((await call(null, 'POST', '/api/auth/nonce', { wallet: 'not-a-wallet' })).status === 400, 'invalid wallet rejected');
const noHeader = await fetch(BASE + '/api/auth/nonce', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: alice.address }) });
ok(noHeader.status === 403, 'POST without app header is refused (CSRF guard)');

// profiles
ok((await call(alice, 'POST', '/api/gigs', {})).status === 403, 'cannot post a gig before choosing a username');
let r = await call(alice, 'PUT', '/api/me', { handle: 'Alice-Design', display_name: 'Alice', bio: 'Designer', country: 'Portugal', available: true, hourly_ltmx: 100 });
ok(r.status === 200 && r.data.user.handle === 'alice-design', 'profile saved, username lowercased');
await login(bob);
ok((await call(bob, 'PUT', '/api/me', { handle: 'alice-design', display_name: 'Bob' })).status === 400, 'duplicate username rejected');
ok((await call(bob, 'PUT', '/api/me', { handle: 'bob', display_name: 'Bob' })).status === 200, 'second user profile saved');

// agent registration
await login(bot);
r = await call(bot, 'PUT', '/api/me', { handle: 'tidy-bot', display_name: 'TidyBot', kind: 'agent', operator_wallet: bot.address, human_review: 'none' });
ok(r.status === 400, 'agent cannot be its own operator');
r = await call(bot, 'PUT', '/api/me', { handle: 'tidy-bot', display_name: 'TidyBot', kind: 'agent', operator_wallet: bob.address, human_review: 'spot-checked', manifest_url: 'https://example.com/m.json' });
ok(r.status === 200 && r.data.user.kind === 'agent' && r.data.user.operator_approved === false, 'agent registered, waiting for operator');
ok((await call(bot, 'PUT', '/api/me', { handle: 'tidy-bot', display_name: 'TidyBot', kind: 'person' })).status === 403, 'agent cannot switch back to person');
ok((await call(bot, 'POST', '/api/gigs', { title: 'I will clean your CSV data', description: 'Fast and careful CSV cleaning for up to 10k rows.', category: 'data', price_ltmx: 100, delivery_days: 1 })).status === 403, 'unapproved agent cannot post');
ok((await call(alice, 'POST', `/api/agents/${bot.address}/approve`)).status === 404, 'only the named operator can approve');
r = await call(bob, 'GET', '/api/me');
ok(r.data.agents.length === 1 && r.data.agents[0].handle === 'tidy-bot', 'operator sees the agent in their dashboard');
ok((await call(bob, 'POST', `/api/agents/${bot.address}/approve`)).status === 200, 'operator approves agent');

// gigs
r = await call(alice, 'POST', '/api/gigs', { title: 'I will design a clean logo', description: 'Three concepts, two revisions, final files in SVG and PNG.', category: 'design', price_ltmx: 900, delivery_days: 5 });
ok(r.status === 201, 'person creates gig');
const gigId = r.data.id;
r = await call(bot, 'POST', '/api/gigs', { title: 'I will clean your CSV data', description: 'Fast and careful CSV cleaning for up to 10k rows.', category: 'data', price_ltmx: 100, delivery_days: 1 });
ok(r.status === 201, 'approved agent creates gig');
ok((await call(alice, 'POST', '/api/gigs', { title: 'short', description: 'x', category: 'design', price_ltmx: 1, delivery_days: 1 })).status === 400, 'gig validation works');
r = await call(null, 'GET', '/api/gigs');
ok(r.data.gigs.length === 2, 'public gig list shows both');
r = await call(null, 'GET', '/api/gigs?who=agents');
ok(r.data.gigs.length === 1 && r.data.gigs[0].seller.kind === 'agent' && r.data.gigs[0].seller.operator === 'bob', 'agent filter + operator shown');
r = await call(null, 'GET', '/api/gigs?q=logo');
ok(r.data.gigs.length === 1 && r.data.gigs[0].id === gigId, 'search works');
ok((await call(bob, 'PUT', `/api/gigs/${gigId}`, { title: 'Hijacked title here', description: 'Trying to edit someone else gig here.', category: 'design', price_ltmx: 1, delivery_days: 1 })).status === 404, 'cannot edit another user gig');
await call(bob, 'POST', `/api/agents/${bot.address}/revoke`);
r = await call(null, 'GET', '/api/gigs?who=agents');
ok(r.data.gigs.length === 0, 'revoked agent disappears from listings');
await call(bob, 'POST', `/api/agents/${bot.address}/approve`);

// projects + bids with agent policy
r = await call(alice, 'POST', '/api/projects', { title: 'Need product photos edited', description: 'Retouch 20 product photos on white background, consistent shadows.', category: 'design', budget_ltmx: 2000, days: 7, agent_policy: 0, skills: ['Photoshop'] });
const peopleOnly = r.data.id;
r = await call(alice, 'POST', '/api/projects', { title: 'Label 2,000 support tickets', description: 'Sort exported tickets into 12 given categories, CSV in, CSV out.', category: 'data', budget_ltmx: 900, days: 3, agent_policy: 2 });
const agentsOnly = r.data.id;
ok((await call(bot, 'POST', `/api/projects/${peopleOnly}/bids`, { price_ltmx: 1500, days: 5, note: 'I can do this quickly and accurately.' })).status === 403, 'agent blocked from people-only project');
ok((await call(bob, 'POST', `/api/projects/${agentsOnly}/bids`, { price_ltmx: 800, days: 2, note: 'I can do this quickly and accurately.' })).status === 403, 'person blocked from agents-only project');
ok((await call(alice, 'POST', `/api/projects/${peopleOnly}/bids`, { price_ltmx: 800, days: 2, note: 'Bidding on my own project here.' })).status === 400, 'cannot bid on own project');
r = await call(bot, 'POST', `/api/projects/${agentsOnly}/bids`, { price_ltmx: 850, days: 1, note: 'Automated labelling with spot checks by my operator.' });
ok(r.status === 201, 'agent bids on agents-only project');
const botBid = r.data.id;
ok((await call(bot, 'POST', `/api/projects/${agentsOnly}/bids`, { price_ltmx: 800, days: 1, note: 'Second bid attempt on the same project.' })).status === 400, 'one bid per project');
r = await call(bob, 'POST', `/api/projects/${peopleOnly}/bids`, { price_ltmx: 1800, days: 6, note: 'Ten years of product retouching experience.' });
ok(r.status === 201, 'person bids on people-only project');
r = await call(null, 'GET', `/api/projects/${agentsOnly}`);
ok(r.data.bids.length === 0 && r.data.project.bid_count === 1, 'bids hidden from public, count shown');
r = await call(alice, 'GET', `/api/projects/${agentsOnly}`);
ok(r.data.bids.length === 1 && r.data.bids[0].bidder.kind === 'agent', 'owner sees bids with agent label');
ok((await call(bob, 'POST', `/api/bids/${botBid}/accept`)).status === 404, 'only project owner can accept');
ok((await call(alice, 'POST', `/api/bids/${botBid}/accept`)).status === 200, 'owner accepts bid');
r = await call(null, 'GET', '/api/projects');
ok(r.data.projects.every((p) => p.id !== agentsOnly), 'awarded project leaves the open list');
r = await call(bot, 'GET', '/api/me/bids');
ok(r.data.bids[0].status === 'accepted', 'bidder sees accepted status');

// instant hire
r = await call(null, 'GET', '/api/hire');
ok(r.data.people.some((p) => p.handle === 'alice-design'), 'available user shows in instant hire');

// messages
r = await call(bob, 'POST', '/api/conversations', { with: alice.address, context_type: 'gig', context_id: gigId });
const convo = r.data.id;
ok(r.status === 200 && convo, 'conversation opened');
ok((await call(bob, 'POST', '/api/conversations', { with: alice.address, context_type: 'gig', context_id: gigId })).data.id === convo, 'same conversation reused');
ok((await call(bob, 'POST', `/api/conversations/${convo}/messages`, { body: 'Hi! Can you do a logo by Friday?' })).status === 201, 'message sent');
r = await call(alice, 'GET', '/api/me');
ok(r.data.unread === 1, 'recipient has 1 unread');
r = await call(alice, 'GET', `/api/conversations/${convo}/messages`);
ok(r.data.messages.length === 1, 'recipient reads message');
ok((await call(alice, 'GET', '/api/me')).data.unread === 0, 'unread cleared after reading');
ok((await call(bot, 'GET', `/api/conversations/${convo}/messages`)).status === 404, 'outsider cannot read conversation');
r = await call(alice, 'GET', '/api/conversations');
ok(r.data.conversations[0].context_title === 'I will design a clean logo', 'conversation list shows context');

// uploads
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const fd = new FormData(); fd.append('file', new Blob([png], { type: 'image/png' }), 'x.png');
r = await call(alice, 'POST', '/api/uploads', fd);
ok(r.status === 201 && /^[a-f0-9]{32}\.png$/.test(r.data.key), 'image upload');
const img = await fetch(BASE + r.data.url);
ok(img.status === 200 && img.headers.get('content-type') === 'image/png', 'image served');
const fd2 = new FormData(); fd2.append('file', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'x.svg');
ok((await call(alice, 'POST', '/api/uploads', fd2)).status === 400, 'svg upload rejected');

// reports + admin
ok((await call(bob, 'POST', '/api/reports', { target_type: 'gig', target_id: gigId, reason: 'Testing the report flow.' })).status === 201, 'report created');
ok((await call(bob, 'GET', '/api/admin/reports')).status === 403, 'non-admin blocked from admin');
if (process.env.ADMIN_KEY) {
  const adm = { kp: nacl.sign.keyPair.fromSecretKey(bs58.decode(process.env.ADMIN_KEY)), token: null };
  adm.address = bs58.encode(adm.kp.publicKey);
  await login(adm);
  r = await call(adm, 'GET', '/api/admin/reports');
  ok(r.status === 200 && r.data.reports.length === 1, 'admin sees report');
  ok((await call(adm, 'POST', '/api/admin/hide', { type: 'gig', id: gigId })).status === 200, 'admin hides gig');
  ok((await call(null, 'GET', `/api/gigs/${gigId}`)).status === 404, 'hidden gig not public');
  ok((await call(adm, 'POST', `/api/admin/users/${bob.address}/ban`, { banned: true })).status === 200, 'admin bans operator');
  r = await call(null, 'GET', '/api/gigs?who=agents');
  ok(r.data.gigs.length === 0, "banned operator's agent disappears");
  ok((await call(bob, 'GET', '/api/me')).data.user === null, 'banned user session ends');
}

// logout
await call(alice, 'POST', '/api/auth/logout');
ok((await call(alice, 'GET', '/api/me')).data.user === null, 'logout ends session');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
