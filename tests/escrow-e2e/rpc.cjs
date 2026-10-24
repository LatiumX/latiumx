// A tiny Solana JSON-RPC server backed by LiteSVM, with just the methods the LatiumX site and
// @solana/web3.js use. It runs the real compiled escrow program, so transactions built by the
// site are executed exactly as a validator would. Test-only helpers start with "lx_".
const http = require('http');
const { LiteSVM, Clock } = require('litesvm');
const kit = require('@solana/kit');
const WebSocket = require('ws');

const b58 = { enc: kit.getBase58Decoder(), dec: kit.getBase58Encoder() }; // bytes -> string / string -> bytes
const toB58 = (bytes) => b58.enc.decode(bytes);
const fromB58 = (s) => new Uint8Array(b58.dec.encode(s));
const txDecoder = kit.getTransactionDecoder();

function createChain() {
  const svm = new LiteSVM().withBlockhashCheck(false).withSigverify(true);
  let offset = 0;
  let slot = 1n;
  const txs = new Map(); // signature -> { slot, err, logs }

  const tick = () => {
    slot += 1n;
    const c = svm.getClock();
    svm.setClock(new Clock(slot, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, BigInt(Math.floor(Date.now() / 1000) + offset)));
  };
  tick();

  return {
    svm,
    setOffset(s) {
      offset = s;
      tick();
    },
    get slot() {
      return Number(slot);
    },
    send(wire) {
      tick();
      const tx = txDecoder.decode(wire);
      const sig = toB58(Object.values(tx.signatures)[0]);
      const res = svm.sendTransaction(tx);
      const failed = typeof res.err === 'function';
      const meta = failed ? res.meta() : res;
      const logs = meta.logs();
      const err = failed ? errorJson(res.err()) : null;
      txs.set(sig, { slot: Number(slot), err, logs });
      return { sig, err, logs };
    },
    tx: (sig) => txs.get(sig),
  };
}

function errorJson(e) {
  if (e && typeof e.index === 'number' && typeof e.err === 'function') {
    const inner = e.err();
    const code = inner && typeof inner === 'object' && 'code' in inner ? inner.code : undefined;
    return code !== undefined ? { InstructionError: [e.index, { Custom: code }] } : { InstructionError: [e.index, String(inner)] };
  }
  return String(e);
}

function startRpc(chain, port) {
  const { svm } = chain;
  const ctx = () => ({ slot: chain.slot });
  const account = (addr) => {
    const a = svm.getAccount(addr);
    return a.exists ? a : null;
  };
  const handlers = {
    getLatestBlockhash: () => ({ context: ctx(), value: { blockhash: svm.latestBlockhash(), lastValidBlockHeight: chain.slot + 150 } }),
    getBlockHeight: () => chain.slot,
    getSlot: () => chain.slot,
    getAccountInfo: ([addr]) => {
      const a = account(addr);
      return {
        context: ctx(),
        value: a && {
          data: [Buffer.from(a.data).toString('base64'), 'base64'],
          executable: a.executable,
          lamports: Number(a.lamports),
          owner: a.programAddress,
          rentEpoch: 0,
          space: a.data.length,
        },
      };
    },
    getBalance: ([addr]) => ({ context: ctx(), value: Number(svm.getBalance(addr) ?? 0n) }),
    getTokenAccountBalance: ([addr]) => {
      const a = account(addr);
      if (!a) throw { code: -32602, message: 'Invalid param: could not find account' };
      const mint = account(toB58(a.data.subarray(0, 32)));
      const decimals = mint.data[44];
      const amount = Buffer.from(a.data.subarray(64, 72)).readBigUInt64LE().toString();
      return { context: ctx(), value: { amount, decimals, uiAmount: Number(amount) / 10 ** decimals, uiAmountString: String(Number(amount) / 10 ** decimals) } };
    },
    sendTransaction: ([b64]) => {
      const { sig, err, logs } = chain.send(Buffer.from(b64, 'base64'));
      if (err) {
        const custom = err.InstructionError?.[1]?.Custom;
        throw {
          code: -32002,
          message: `Transaction simulation failed: Error processing Instruction ${err.InstructionError?.[0] ?? 0}: ${custom !== undefined ? `custom program error: 0x${custom.toString(16)}` : JSON.stringify(err)}`,
          data: { err, logs },
        };
      }
      return sig;
    },
    getSignatureStatuses: ([sigs]) => ({
      context: ctx(),
      value: sigs.map((s) => {
        const t = chain.tx(s);
        return t ? { slot: t.slot, confirmations: null, err: t.err, status: t.err ? { Err: t.err } : { Ok: null }, confirmationStatus: 'confirmed' } : null;
      }),
    }),
    getTransaction: ([sig]) => {
      const t = chain.tx(sig);
      return t ? { slot: t.slot, blockTime: Math.floor(Date.now() / 1000), meta: { err: t.err, logMessages: t.logs }, transaction: {} } : null;
    },
    getMinimumBalanceForRentExemption: ([len]) => Number(svm.minimumBalanceForRentExemption(BigInt(len))),
    lx_setOffset: ([s]) => (chain.setOffset(s), true),
  };

  const server = http.createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    if (req.method === 'OPTIONS') return res.end();
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let reqs;
      try {
        reqs = JSON.parse(body);
      } catch {
        res.statusCode = 400;
        return res.end();
      }
      const one = (r) => {
        const h = handlers[r.method];
        if (!h) return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: `Method not found: ${r.method}` } };
        try {
          return { jsonrpc: '2.0', id: r.id, result: h(r.params || []) };
        } catch (e) {
          return { jsonrpc: '2.0', id: r.id, error: e && e.code ? e : { code: -32603, message: String(e && e.message ? e.message : e) } };
        }
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(reqs) ? reqs.map(one) : one(reqs)));
    });
  });
  server.listen(port, '127.0.0.1');

  // web3.js confirms transactions over a websocket on port + 1.
  const wss = new WebSocket.Server({ port: port + 1, host: '127.0.0.1' });
  let nextSub = 1;
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.method === 'signatureSubscribe') {
        const sub = nextSub++;
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: sub }));
        const t = chain.tx(m.params[0]);
        if (t) ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'signatureNotification', params: { subscription: sub, result: { context: { slot: t.slot }, value: { err: t.err } } } }));
      } else {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method.endsWith('Unsubscribe') ? true : nextSub++ }));
      }
    });
  });
  return { close: () => (server.close(), wss.close()) };
}

module.exports = { createChain, startRpc, toB58, fromB58 };
