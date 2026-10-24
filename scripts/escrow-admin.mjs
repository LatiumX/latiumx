// Escrow setup and admin from the command line. Signs with a local keypair file (the program's
// upgrade authority for `init`, the admin for everything else).
//
//   node scripts/escrow-admin.mjs <command> [options]
//
//   init     --arbiter <wallet> --fee-wallet <wallet> --fee-bps <0..1000>
//   update   --arbiter <wallet> --fee-wallet <wallet> --fee-bps <0..1000> [--paused]
//   allow    --mint <mint>          allow a token for new escrows
//   block    --mint <mint>          stop a token being used for new escrows
//   show                            print the current config
//
// Common options:
//   --rpc <url>          default https://api.devnet.solana.com
//   --program <id>       default G48Xix7oG6FL7hMArJgGyc5qtvjn3BX5BF21x3LYqGbN
//   --keypair <path>     default ~/.config/solana/id.json
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';

const LOADER_V3 = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const rpc = opt('rpc', 'https://api.devnet.solana.com');
const programId = new PublicKey(opt('program', 'G48Xix7oG6FL7hMArJgGyc5qtvjn3BX5BF21x3LYqGbN'));
const keypairPath = opt('keypair', `${os.homedir()}/.config/solana/id.json`).replace(/^~/, os.homedir());
const conn = new Connection(rpc, 'confirmed');
const disc = (name) => crypto.createHash('sha256').update(name).digest().subarray(0, 8);
const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId);

function signer() {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8'))));
}

function configArgs() {
  const arbiter = new PublicKey(opt('arbiter'));
  const feeWallet = new PublicKey(opt('fee-wallet'));
  const fee = Number(opt('fee-bps'));
  if (!Number.isInteger(fee) || fee < 0 || fee > 1000) throw new Error('--fee-bps must be 0 to 1000 (1000 = 10%)');
  const feeBuf = Buffer.alloc(2);
  feeBuf.writeUInt16LE(fee);
  return Buffer.concat([arbiter.toBuffer(), feeWallet.toBuffer(), feeBuf]);
}

async function send(ix, kp) {
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [kp]);
  console.log(`done: ${sig}`);
}

async function show() {
  const acc = await conn.getAccountInfo(config);
  if (!acc) return console.log('No config yet. Run `init` first.');
  const d = acc.data;
  const key = (o) => new PublicKey(d.subarray(o, o + 32)).toBase58();
  console.log({
    admin: key(8),
    pending_admin: key(40),
    arbiter: key(72),
    fee_wallet: key(104),
    fee_bps: d.readUInt16LE(136),
    paused: d[138] === 1,
  });
}

const kp = cmd === 'show' ? null : signer();
if (cmd === 'init') {
  const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], LOADER_V3);
  await send(
    new TransactionInstruction({
      programId,
      keys: [
        { pubkey: kp.publicKey, isSigner: true, isWritable: true },
        { pubkey: config, isSigner: false, isWritable: true },
        { pubkey: programId, isSigner: false, isWritable: false },
        { pubkey: programData, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc('global:init_config'), configArgs()]),
    }),
    kp,
  );
} else if (cmd === 'update') {
  await send(
    new TransactionInstruction({
      programId,
      keys: [
        { pubkey: kp.publicKey, isSigner: true, isWritable: false },
        { pubkey: config, isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([disc('global:update_config'), configArgs(), Buffer.from([flag('paused') ? 1 : 0])]),
    }),
    kp,
  );
} else if (cmd === 'allow' || cmd === 'block') {
  const mint = new PublicKey(opt('mint'));
  const [allowed] = PublicKey.findProgramAddressSync([Buffer.from('mint'), mint.toBuffer()], programId);
  await send(
    new TransactionInstruction({
      programId,
      keys: [
        { pubkey: kp.publicKey, isSigner: true, isWritable: true },
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: allowed, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc('global:set_mint'), Buffer.from([cmd === 'allow' ? 1 : 0])]),
    }),
    kp,
  );
} else if (cmd === 'show') {
  await show();
} else {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 16).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(1);
}
