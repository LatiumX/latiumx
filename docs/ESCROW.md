# LatiumX escrow

Escrow is **switched off** on the live site until `ESCROW_PROGRAM_ID` is set. Nothing has been deployed on-chain. This guide covers testing it on devnet first, then the steps to take before mainnet.

## How it works

A client locks an SPL token payment (USDC, LTMX, ...) for one job. The money sits in a vault owned by the escrow account, so neither side can move it alone.

| Who | Can do | When |
|---|---|---|
| Client | Release payment to the freelancer | Any time before a dispute |
| Freelancer | Mark the work delivered | While funded |
| Freelancer | Claim payment | Delivered, and the review period (1 to 30 days) has passed with no dispute |
| Freelancer | Refund the client in full (no fee) | Any time before a dispute |
| Client | Take the money back | The delivery deadline passed and nothing was marked delivered |
| Either | Open a dispute | Any time before it's settled. Freezes everything above |
| Arbiter | Split a disputed escrow, 0 to 100% to the freelancer | Disputed only |

* The platform fee (0 to 10%, set by the admin) comes only out of the freelancer's share and is fixed at the moment the escrow is funded.
* Only tokens the admin has allowed can be used. Token-2022 tokens with transfer fees, transfer hooks, permanent delegates, frozen-by-default accounts and similar extensions are refused, because they could trap or skim the vault.
* Pausing only blocks new escrows. Money already locked can always be released, refunded or settled.
* When an escrow settles, the vault and escrow accounts are closed and the rent goes back to the client.
* The site never holds money. The browser sends transactions straight to the program; the server only reads results back from the chain (`POST /api/escrows/sync`) and keeps a list for the dashboard.

Code: `programs/latiumx-escrow/src/lib.rs` (Anchor 1.2.1). Program id in the repo: `G48Xix7oG6FL7hMArJgGyc5qtvjn3BX5BF21x3LYqGbN`. The keypair for that id is **not** in the repo. For your own deploy, generate a new one (step 2 below).

## Tests already run

* `programs/latiumx-escrow/tests/escrow.rs`: 15 Rust tests that run the compiled program in LiteSVM. Covers every path above plus: only the upgrade authority can set up the config, two-step admin handover, swapped or fake accounts, someone else's tokens, fee snapshot, pause, tokens sent straight to the vault, Token-2022, and an unsafe Token-2022 mint being refused.
* `tests/escrow-e2e/`: the real site and a real browser with simulated wallets, against the compiled program on a local test chain. 22 checks: fund from a project, deliver, release, dispute and a 60/40 split by the arbiter, reclaim after a missed deadline, claim after the review period, refund, payouts shown on the page match the chain, and the phone layout.

These tests are not an audit.

## 1. Tools (on your computer)

```bash
# Rust, Solana CLI and Anchor
curl --proto '=https' --tlsv1.2 -sSfL https://solana-install.solana.workers.dev | bash
solana --version && anchor --version
```

## 2. Deploy to devnet

```bash
git clone https://github.com/LatiumX/latiumx && cd latiumx
solana config set --url devnet
solana-keygen new                               # your devnet wallet (~/.config/solana/id.json)
solana airdrop 5                                # free devnet SOL (or use faucet.solana.com)

# A fresh program id that only you control
solana-keygen new -o target/deploy/latiumx_escrow-keypair.json
anchor keys sync                                # writes the new id into lib.rs and Anchor.toml
cd programs/latiumx-escrow && cargo build-sbf && cargo test && cd ../..
solana program deploy target/deploy/latiumx_escrow.so --program-id target/deploy/latiumx_escrow-keypair.json
```

Then set it up. `init` must be signed by the wallet that deployed the program:

```bash
node scripts/escrow-admin.mjs init --program <PROGRAM_ID> --arbiter <your Phantom wallet> --fee-wallet <your Phantom wallet> --fee-bps 0
node scripts/escrow-admin.mjs allow --program <PROGRAM_ID> --mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU   # devnet USDC
node scripts/escrow-admin.mjs show --program <PROGRAM_ID>
```

Devnet USDC comes from https://faucet.circle.com (pick Solana Devnet).

## 3. Turn it on for the site (devnet)

1. In the D1 console, run `migrations/0002_escrows.sql` once.
2. In `wrangler.toml` set:
   ```toml
   ESCROW_PROGRAM_ID = "<PROGRAM_ID>"
   SOLANA_CLUSTER = "devnet"
   ESCROW_MINTS = '[{"symbol":"USDC","mint":"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU","decimals":6}]'
   ```
3. Push to `main`. The banner on every page now says escrow is in devnet test mode.
4. In Phantom: Settings → Developer Settings → Testnet Mode on → Solana Devnet.

Check: post a project from one wallet, bid from another, accept, fund, deliver, release. Then try a dispute and resolve it from the Admin page with the arbiter wallet.

## 4. Before mainnet

1. **Independent audit** of `programs/latiumx-escrow` by a Solana security firm (for example OtterSec, Neodyme, Sec3, Zellic, Halborn, Accretion). Fix everything they find and publish the report.
2. **Upgrade authority**: move it to a multisig (Squads) so no single key can replace the program. Use a separate multisig or hardware wallet for the arbiter and admin.
3. **RPC**: get a paid RPC (Helius, Triton, QuickNode). Put the private URL in the Pages dashboard as an encrypted secret named `SOLANA_RPC`, and a browser-safe URL in `SOLANA_PUBLIC_RPC`.
4. **Legal**: have a lawyer review the Terms (escrow, disputes, fees) for where you operate. Holding and splitting other people's money can be regulated.
5. Deploy to mainnet, `init`, `allow` USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) and, once it exists, the LTMX mint. Then set `SOLANA_CLUSTER = "mainnet-beta"`.
6. Start with small amounts and a low cap on what you promote.

## Admin commands

```bash
node scripts/escrow-admin.mjs update --arbiter <wallet> --fee-wallet <wallet> --fee-bps 250   # 2.5% fee
node scripts/escrow-admin.mjs update --arbiter <wallet> --fee-wallet <wallet> --fee-bps 250 --paused
node scripts/escrow-admin.mjs block --mint <mint>
```

All commands take `--rpc`, `--program` and `--keypair`.
