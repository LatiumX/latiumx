//! Runs the compiled program (target/deploy/latiumx_escrow.so) in LiteSVM.
//! Build first with `cargo build-sbf`, then `cargo test`.

use anchor_lang::prelude::{Clock, Pubkey};
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::associated_token::get_associated_token_address_with_program_id as ata;
use latiumx_escrow::{accounts as acc, instruction as ix, Config, Escrow, EscrowState, DAY};
use litesvm::LiteSVM;
use litesvm_token::{CreateAssociatedTokenAccount, CreateMint, MintTo};
use solana_keypair::Keypair;
use solana_loader_v3_interface::state::UpgradeableLoaderState;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use anchor_lang::solana_program::instruction::Instruction;

const PROGRAM: Pubkey = latiumx_escrow::ID;
const TOKEN: Pubkey = anchor_spl::token::ID;
const TOKEN_2022: Pubkey = anchor_spl::token_2022::ID;
const SYSTEM: Pubkey = anchor_lang::system_program::ID;
const ATA_PROGRAM: Pubkey = anchor_spl::associated_token::ID;
const LOADER_V3: Pubkey = anchor_lang::solana_program::bpf_loader_upgradeable::ID;

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    arbiter: Keypair,
    fee_wallet: Keypair,
    client: Keypair,
    freelancer: Keypair,
    stranger: Keypair,
    mint: Pubkey,
    token_program: Pubkey,
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &PROGRAM).0
}
fn config_pda() -> Pubkey {
    pda(&[b"config"])
}
fn mint_pda(mint: &Pubkey) -> Pubkey {
    pda(&[b"mint", mint.as_ref()])
}
fn escrow_pda(client: &Pubkey, id: u64) -> Pubkey {
    pda(&[b"escrow", client.as_ref(), &id.to_le_bytes()])
}
fn vault_pda(escrow: &Pubkey) -> Pubkey {
    pda(&[b"vault", escrow.as_ref()])
}
fn programdata() -> Pubkey {
    Pubkey::find_program_address(&[PROGRAM.as_ref()], &LOADER_V3).0
}

impl Env {
    fn new(token_program: Pubkey) -> Self {
        let mut svm = LiteSVM::new();
        let so = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/latiumx_escrow.so"))
            .expect("run `cargo build-sbf` first");
        svm.add_program(PROGRAM, &so).unwrap();
        let [admin, arbiter, fee_wallet, client, freelancer, stranger] =
            std::array::from_fn(|_| Keypair::new());
        for k in [&admin, &arbiter, &fee_wallet, &client, &freelancer, &stranger] {
            svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
        }
        // Make `admin` the program's upgrade authority, as a real deploy would.
        let pd = programdata();
        let mut account = svm.get_account(&pd).unwrap();
        let meta = UpgradeableLoaderState::size_of_programdata_metadata();
        let state = UpgradeableLoaderState::ProgramData { slot: 0, upgrade_authority_address: Some(admin.pubkey()) };
        account.data[..meta].copy_from_slice(&bincode::serialize(&state).unwrap());
        svm.set_account(pd, account).unwrap();

        let mint = CreateMint::new(&mut svm, &admin)
            .decimals(6)
            .token_program_id(&token_program)
            .send()
            .unwrap();
        let mut env = Env { svm, admin, arbiter, fee_wallet, client, freelancer, stranger, mint, token_program };
        let client_ata = CreateAssociatedTokenAccount::new(&mut env.svm, &env.client, &mint)
            .token_program_id(&token_program)
            .send()
            .unwrap();
        MintTo::new(&mut env.svm, &env.admin, &mint, &client_ata, 1_000_000_000)
            .token_program_id(&token_program)
            .send()
            .unwrap();
        env
    }

    /// Admin sets up config with a 2.5% fee and allows the mint.
    fn ready(token_program: Pubkey) -> Self {
        let mut env = Self::new(token_program);
        env.init_config(&env.admin.insecure_clone(), 250).unwrap();
        env.set_mint(true).unwrap();
        env
    }

    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        self.svm.expire_blockhash();
        let msg = Message::new(ixs, Some(&signers[0].pubkey()));
        let tx = Transaction::new(signers, msg, self.svm.latest_blockhash());
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
    }

    fn init_config(&mut self, signer: &Keypair, fee_bps: u16) -> Result<(), String> {
        let ix = Instruction {
            program_id: PROGRAM,
            accounts: acc::InitConfig {
                admin: signer.pubkey(),
                config: config_pda(),
                program: PROGRAM,
                program_data: programdata(),
                system_program: SYSTEM,
            }
            .to_account_metas(None),
            data: ix::InitConfig { arbiter: self.arbiter.pubkey(), fee_recipient: self.fee_wallet.pubkey(), fee_bps }.data(),
        };
        self.send(&[ix], &[signer])
    }

    fn update_config(&mut self, signer: &Keypair, fee_bps: u16, paused: bool) -> Result<(), String> {
        let ix = Instruction {
            program_id: PROGRAM,
            accounts: acc::AdminOnly { admin: signer.pubkey(), config: config_pda() }.to_account_metas(None),
            data: ix::UpdateConfig { arbiter: self.arbiter.pubkey(), fee_recipient: self.fee_wallet.pubkey(), fee_bps, paused }.data(),
        };
        self.send(&[ix], &[signer])
    }

    fn set_mint(&mut self, enabled: bool) -> Result<(), String> {
        let ix = Instruction {
            program_id: PROGRAM,
            accounts: acc::SetMint {
                admin: self.admin.pubkey(),
                config: config_pda(),
                mint: self.mint,
                allowed_mint: mint_pda(&self.mint),
                system_program: SYSTEM,
            }
            .to_account_metas(None),
            data: ix::SetMint { enabled }.data(),
        };
        let admin = self.admin.insecure_clone();
        self.send(&[ix], &[&admin])
    }

    fn create_ix(&self, client: &Pubkey, freelancer: &Pubkey, id: u64, amount: u64, delivery: i64, review: i64) -> Instruction {
        let escrow = escrow_pda(client, id);
        Instruction {
            program_id: PROGRAM,
            accounts: acc::CreateEscrow {
                client: *client,
                freelancer: *freelancer,
                config: config_pda(),
                mint: self.mint,
                allowed_mint: mint_pda(&self.mint),
                escrow,
                vault: vault_pda(&escrow),
                client_token: ata(client, &self.mint, &self.token_program),
                token_program: self.token_program,
                system_program: SYSTEM,
            }
            .to_account_metas(None),
            data: ix::CreateEscrow { id, amount, delivery_seconds: delivery, review_seconds: review, ref_kind: 1, ref_id: 42 }.data(),
        }
    }

    fn create(&mut self, id: u64, amount: u64) -> Result<Pubkey, String> {
        let ix = self.create_ix(&self.client.pubkey(), &self.freelancer.pubkey(), id, amount, 7 * DAY, 3 * DAY);
        let client = self.client.insecure_clone();
        self.send(&[ix], &[&client])?;
        Ok(escrow_pda(&self.client.pubkey(), id))
    }

    fn settle_accounts(&self, signer: &Pubkey, escrow: &Pubkey) -> Vec<anchor_lang::solana_program::instruction::AccountMeta> {
        let client = self.client.pubkey();
        let freelancer = self.freelancer.pubkey();
        let fee = self.fee_wallet.pubkey();
        acc::Settle {
            signer: *signer,
            config: config_pda(),
            escrow: *escrow,
            vault: vault_pda(escrow),
            mint: self.mint,
            client,
            freelancer,
            fee_recipient: fee,
            client_token: ata(&client, &self.mint, &self.token_program),
            freelancer_token: ata(&freelancer, &self.mint, &self.token_program),
            fee_token: ata(&fee, &self.mint, &self.token_program),
            token_program: self.token_program,
            associated_token_program: ATA_PROGRAM,
            system_program: SYSTEM,
        }
        .to_account_metas(None)
    }

    fn settle(&mut self, signer: &Keypair, escrow: &Pubkey, data: Vec<u8>) -> Result<(), String> {
        let ix = Instruction { program_id: PROGRAM, accounts: self.settle_accounts(&signer.pubkey(), escrow), data };
        self.send(&[ix], &[signer])
    }

    fn party(&mut self, signer: &Keypair, escrow: &Pubkey, data: Vec<u8>) -> Result<(), String> {
        let ix = Instruction {
            program_id: PROGRAM,
            accounts: acc::PartyAction { signer: signer.pubkey(), escrow: *escrow }.to_account_metas(None),
            data,
        };
        self.send(&[ix], &[signer])
    }

    fn deliver(&mut self, signer: &Keypair, escrow: &Pubkey) -> Result<(), String> {
        let ix = Instruction {
            program_id: PROGRAM,
            accounts: acc::FreelancerAction { freelancer: signer.pubkey(), escrow: *escrow }.to_account_metas(None),
            data: ix::MarkDelivered {}.data(),
        };
        self.send(&[ix], &[signer])
    }

    fn balance(&self, owner: &Pubkey) -> u64 {
        let a = ata(owner, &self.mint, &self.token_program);
        match self.svm.get_account(&a) {
            Some(acc) if acc.data.len() >= 72 => u64::from_le_bytes(acc.data[64..72].try_into().unwrap()),
            _ => 0,
        }
    }

    fn escrow(&self, key: &Pubkey) -> Option<Escrow> {
        let a = self.svm.get_account(key)?;
        if a.data.is_empty() {
            return None;
        }
        Some(Escrow::try_deserialize(&mut a.data.as_slice()).unwrap())
    }

    fn warp(&mut self, seconds: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp += seconds;
        self.svm.set_sysvar(&clock);
    }

    fn c(&self) -> Keypair {
        self.client.insecure_clone()
    }
    fn f(&self) -> Keypair {
        self.freelancer.insecure_clone()
    }
}

fn expect_err(r: Result<(), String>, needle: &str) {
    match r {
        Ok(()) => panic!("expected failure containing {needle:?}, but it succeeded"),
        Err(e) => assert!(e.contains(needle), "expected {needle:?} in:\n{e}"),
    }
}

const START: u64 = 1_000_000_000;

#[test]
fn only_upgrade_authority_can_init_config() {
    let mut env = Env::new(TOKEN);
    let stranger = env.stranger.insecure_clone();
    expect_err(env.init_config(&stranger, 0), "NotUpgradeAuthority");
    let admin = env.admin.insecure_clone();
    expect_err(env.init_config(&admin, 1_001), "FeeTooHigh");
    env.init_config(&admin, 250).unwrap();
    expect_err(env.init_config(&admin, 250), "already in use");
    let cfg = Config::try_deserialize(&mut env.svm.get_account(&config_pda()).unwrap().data.as_slice()).unwrap();
    assert_eq!(cfg.admin, admin.pubkey());
    assert_eq!(cfg.fee_bps, 250);
}

#[test]
fn config_changes_need_admin_and_handover_is_two_step() {
    let mut env = Env::ready(TOKEN);
    let stranger = env.stranger.insecure_clone();
    let admin = env.admin.insecure_clone();
    expect_err(env.update_config(&stranger, 0, false), "NotAdmin");
    expect_err(env.update_config(&admin, 2_000, false), "FeeTooHigh");

    let propose = Instruction {
        program_id: PROGRAM,
        accounts: acc::AdminOnly { admin: admin.pubkey(), config: config_pda() }.to_account_metas(None),
        data: ix::ProposeAdmin { new_admin: stranger.pubkey() }.data(),
    };
    env.send(&[propose], &[&admin]).unwrap();
    let accept = |k: &Keypair| Instruction {
        program_id: PROGRAM,
        accounts: acc::AcceptAdmin { new_admin: k.pubkey(), config: config_pda() }.to_account_metas(None),
        data: ix::AcceptAdmin {}.data(),
    };
    let client = env.c();
    expect_err(env.send(&[accept(&client)], &[&client]), "NotAdmin");
    env.send(&[accept(&stranger)], &[&stranger]).unwrap();
    expect_err(env.update_config(&admin, 0, false), "NotAdmin");
    env.update_config(&stranger, 0, false).unwrap();
}

#[test]
fn create_checks_inputs() {
    let mut env = Env::new(TOKEN);
    let admin = env.admin.insecure_clone();
    env.init_config(&admin, 250).unwrap();
    // Mint not on the allow list yet: the allow-list account doesn't exist.
    expect_err(env.create(1, 100).map(|_| ()), "AccountNotInitialized");
    env.set_mint(false).unwrap();
    expect_err(env.create(1, 100).map(|_| ()), "MintNotAllowed");
    env.set_mint(true).unwrap();

    expect_err(env.create(1, 0).map(|_| ()), "ZeroAmount");
    let (c, f) = (env.client.pubkey(), env.freelancer.pubkey());
    let client = env.c();
    let self_pay = env.create_ix(&c, &c, 1, 100, 7 * DAY, 3 * DAY);
    expect_err(env.send(&[self_pay], &[&client]), "SelfEscrow");
    for (d, r) in [(DAY - 1, 3 * DAY), (366 * DAY, 3 * DAY), (7 * DAY, DAY - 1), (7 * DAY, 31 * DAY)] {
        let bad = env.create_ix(&c, &f, 1, 100, d, r);
        expect_err(env.send(&[bad], &[&client]), "BadPeriod");
    }
    // Someone else can't fund an escrow from the client's tokens.
    let stranger = env.stranger.insecure_clone();
    let mut theft = env.create_ix(&stranger.pubkey(), &f, 1, 100, 7 * DAY, 3 * DAY);
    theft.accounts[7].pubkey = ata(&c, &env.mint, &TOKEN); // client_token
    expect_err(env.send(&[theft], &[&stranger]), "ConstraintTokenOwner");

    let e = env.create(1, 5_000_000).unwrap();
    assert_eq!(env.balance(&c), START - 5_000_000);
    let esc = env.escrow(&e).unwrap();
    assert_eq!(esc.amount, 5_000_000);
    assert_eq!(esc.state, EscrowState::Funded);
    assert_eq!(esc.fee_bps, 250);
    assert_eq!(esc.ref_id, 42);
    // Same id twice is rejected.
    expect_err(env.create(1, 5_000_000).map(|_| ()), "already in use");
}

#[test]
fn client_release_pays_freelancer_minus_fee_and_closes_accounts() {
    let mut env = Env::ready(TOKEN);
    let e = env.create(7, 10_000_000).unwrap();
    let rent_before = env.svm.get_balance(&env.client.pubkey()).unwrap();

    let (f, s) = (env.f(), env.stranger.insecure_clone());
    expect_err(env.settle(&f, &e, ix::Release {}.data()), "NotClient");
    expect_err(env.settle(&s, &e, ix::Release {}.data()), "NotClient");

    let c = env.c();
    env.settle(&c, &e, ix::Release {}.data()).unwrap();
    assert_eq!(env.balance(&env.freelancer.pubkey()), 9_750_000);
    assert_eq!(env.balance(&env.fee_wallet.pubkey()), 250_000);
    assert_eq!(env.balance(&env.client.pubkey()), START - 10_000_000);
    assert!(env.escrow(&e).is_none(), "escrow account closed");
    assert!(env.svm.get_account(&vault_pda(&e)).map_or(true, |a| a.lamports == 0), "vault closed");
    // The client got back the escrow and vault rent (less the ATAs it paid for).
    assert!(env.svm.get_balance(&env.client.pubkey()).unwrap() > rent_before - 5_000_000);
    // Can't release twice.
    expect_err(env.settle(&c, &e, ix::Release {}.data()), "AccountNotInitialized");
}

#[test]
fn delivery_then_claim_after_review_period() {
    let mut env = Env::ready(TOKEN);
    let e = env.create(1, 1_000_000).unwrap();
    let (c, f) = (env.c(), env.f());

    expect_err(env.settle(&f, &e, ix::Claim {}.data()), "WrongState");
    expect_err(env.deliver(&c, &e), "NotFreelancer");
    env.deliver(&f, &e).unwrap();
    expect_err(env.deliver(&f, &e), "WrongState");
    assert_eq!(env.escrow(&e).unwrap().state, EscrowState::Delivered);

    expect_err(env.settle(&f, &e, ix::Claim {}.data()), "TooEarly");
    env.warp(3 * DAY - 10);
    expect_err(env.settle(&f, &e, ix::Claim {}.data()), "TooEarly");
    expect_err(env.settle(&c, &e, ix::Claim {}.data()), "NotFreelancer");
    // Client can't pull the money back after delivery.
    expect_err(env.settle(&c, &e, ix::Reclaim {}.data()), "WrongState");
    env.warp(10);
    env.settle(&f, &e, ix::Claim {}.data()).unwrap();
    assert_eq!(env.balance(&env.freelancer.pubkey()), 975_000);
    assert_eq!(env.balance(&env.fee_wallet.pubkey()), 25_000);
}

#[test]
fn freelancer_refund_returns_everything_without_fee() {
    let mut env = Env::ready(TOKEN);
    let e = env.create(1, 1_000_000).unwrap();
    let (c, f) = (env.c(), env.f());
    expect_err(env.settle(&c, &e, ix::Refund {}.data()), "NotFreelancer");
    env.deliver(&f, &e).unwrap();
    env.settle(&f, &e, ix::Refund {}.data()).unwrap();
    assert_eq!(env.balance(&env.client.pubkey()), START);
    assert_eq!(env.balance(&env.fee_wallet.pubkey()), 0);
    assert_eq!(env.balance(&env.freelancer.pubkey()), 0);
}

#[test]
fn client_reclaims_only_after_missed_deadline() {
    let mut env = Env::ready(TOKEN);
    let e = env.create(1, 1_000_000).unwrap();
    let c = env.c();
    expect_err(env.settle(&c, &e, ix::Reclaim {}.data()), "TooEarly");
    env.warp(7 * DAY);
    expect_err(env.settle(&c, &e, ix::Reclaim {}.data()), "TooEarly");
    env.warp(1);
    let f = env.f();
    expect_err(env.settle(&f, &e, ix::Reclaim {}.data()), "NotClient");
    env.settle(&c, &e, ix::Reclaim {}.data()).unwrap();
    assert_eq!(env.balance(&env.client.pubkey()), START);
}

#[test]
fn dispute_freezes_escrow_until_arbiter_splits_it() {
    let mut env = Env::ready(TOKEN);
    let e = env.create(1, 1_000_000).unwrap();
    let (c, f, s, a) = (env.c(), env.f(), env.stranger.insecure_clone(), env.arbiter.insecure_clone());
    env.deliver(&f, &e).unwrap();

    expect_err(env.party(&s, &e, ix::OpenDispute {}.data()), "NotParty");
    env.party(&c, &e, ix::OpenDispute {}.data()).unwrap();
    expect_err(env.party(&f, &e, ix::OpenDispute {}.data()), "WrongState");
    assert_eq!(env.escrow(&e).unwrap().state, EscrowState::Disputed);

    env.warp(30 * DAY);
    expect_err(env.settle(&f, &e, ix::Claim {}.data()), "WrongState");
    expect_err(env.settle(&c, &e, ix::Release {}.data()), "WrongState");
    expect_err(env.settle(&f, &e, ix::Refund {}.data()), "WrongState");
    expect_err(env.settle(&c, &e, ix::Reclaim {}.data()), "WrongState");

    let admin = env.admin.insecure_clone();
    expect_err(env.settle(&admin, &e, ix::Resolve { freelancer_bps: 5_000 }.data()), "NotArbiter");
    expect_err(env.settle(&c, &e, ix::Resolve { freelancer_bps: 0 }.data()), "NotArbiter");
    expect_err(env.settle(&a, &e, ix::Resolve { freelancer_bps: 10_001 }.data()), "BadSplit");
    env.settle(&a, &e, ix::Resolve { freelancer_bps: 6_000 }.data()).unwrap();
    // 600,000 to the freelancer side, 2.5% fee taken from it; 400,000 back to the client.
    assert_eq!(env.balance(&env.freelancer.pubkey()), 585_000);
    assert_eq!(env.balance(&env.fee_wallet.pubkey()), 15_000);
    assert_eq!(env.balance(&env.client.pubkey()), START - 600_000);
}

#[test]
fn resolve_can_be_all_or_nothing() {
    for (bps, freelancer, client) in [(0u16, 0u64, START), (10_000, 975_000, START - 1_000_000)] {
        let mut env = Env::ready(TOKEN);
        let e = env.create(1, 1_000_000).unwrap();
        let (f, a) = (env.f(), env.arbiter.insecure_clone());
        env.party(&f, &e, ix::OpenDispute {}.data()).unwrap();
        env.settle(&a, &e, ix::Resolve { freelancer_bps: bps }.data()).unwrap();
        assert_eq!(env.balance(&env.freelancer.pubkey()), freelancer);
        assert_eq!(env.balance(&env.client.pubkey()), client);
    }
}

#[test]
fn fee_is_fixed_at_funding_and_pause_only_blocks_new_escrows() {
    let mut env = Env::ready(TOKEN);
    let e = env.create(1, 1_000_000).unwrap();
    let admin = env.admin.insecure_clone();
    env.update_config(&admin, 1_000, true).unwrap();
    expect_err(env.create(2, 1_000_000).map(|_| ()), "Paused");
    let c = env.c();
    env.settle(&c, &e, ix::Release {}.data()).unwrap();
    assert_eq!(env.balance(&env.fee_wallet.pubkey()), 25_000, "old 2.5% fee, not the new 10%");
    env.update_config(&admin, 0, false).unwrap();
    let e2 = env.create(2, 1_000_000).unwrap();
    env.settle(&c, &e2, ix::Release {}.data()).unwrap();
    assert_eq!(env.balance(&env.freelancer.pubkey()), 975_000 + 1_000_000);
}

#[test]
fn settle_rejects_swapped_accounts() {
    let mut env = Env::ready(TOKEN);
    let e = env.create(1, 1_000_000).unwrap();
    let c = env.c();
    let s = env.stranger.insecure_clone().pubkey();
    let mint = env.mint;
    // Swap the freelancer (index 6) and their token account (index 9) for the stranger's.
    let mut accounts = env.settle_accounts(&c.pubkey(), &e);
    accounts[6].pubkey = s;
    accounts[9].pubkey = ata(&s, &mint, &TOKEN);
    let bad = Instruction { program_id: PROGRAM, accounts, data: ix::Release {}.data() };
    expect_err(env.send(&[bad], &[&c]), "ConstraintHasOne");
    // Swap only the fee recipient (index 7, token index 10).
    let mut accounts = env.settle_accounts(&c.pubkey(), &e);
    accounts[7].pubkey = s;
    accounts[10].pubkey = ata(&s, &mint, &TOKEN);
    let bad = Instruction { program_id: PROGRAM, accounts, data: ix::Release {}.data() };
    expect_err(env.send(&[bad], &[&c]), "ConstraintHasOne");
    // Point the payout at the stranger's token account while naming the real freelancer.
    let other = CreateAssociatedTokenAccount::new(&mut env.svm, &c, &mint).owner(&s).token_program_id(&TOKEN).send().unwrap();
    let mut accounts = env.settle_accounts(&c.pubkey(), &e);
    accounts[9].pubkey = other;
    let bad = Instruction { program_id: PROGRAM, accounts, data: ix::Release {}.data() };
    assert!(env.send(&[bad], &[&c]).is_err());
    env.settle(&c, &e, ix::Release {}.data()).unwrap();
    assert_eq!(env.balance(&env.freelancer.pubkey()), 975_000);
}

#[test]
fn tokens_sent_straight_to_the_vault_go_back_to_the_client() {
    let mut env = Env::ready(TOKEN);
    let e = env.create(1, 1_000_000).unwrap();
    let admin = env.admin.insecure_clone();
    let mint = env.mint;
    MintTo::new(&mut env.svm, &admin, &mint, &vault_pda(&e), 123).token_program_id(&TOKEN).send().unwrap();
    let c = env.c();
    env.settle(&c, &e, ix::Release {}.data()).unwrap();
    assert_eq!(env.balance(&env.freelancer.pubkey()), 975_000);
    assert_eq!(env.balance(&env.client.pubkey()), START - 1_000_000 + 123);
}

#[test]
fn works_with_token_2022_mints() {
    let mut env = Env::ready(TOKEN_2022);
    let e = env.create(1, 2_000_000).unwrap();
    let f = env.f();
    env.deliver(&f, &e).unwrap();
    let c = env.c();
    env.settle(&c, &e, ix::Release {}.data()).unwrap();
    assert_eq!(env.balance(&env.freelancer.pubkey()), 1_950_000);
    assert_eq!(env.balance(&env.fee_wallet.pubkey()), 50_000);
}

#[test]
fn many_escrows_per_client_are_independent() {
    let mut env = Env::ready(TOKEN);
    let e1 = env.create(1, 100_000).unwrap();
    let e2 = env.create(2, 200_000).unwrap();
    let (c, f) = (env.c(), env.f());
    env.settle(&f, &e2, ix::Refund {}.data()).unwrap();
    assert!(env.escrow(&e1).is_some());
    env.settle(&c, &e1, ix::Release {}.data()).unwrap();
    assert_eq!(env.balance(&env.client.pubkey()), START - 100_000);
}

#[test]
fn refuses_token_2022_mints_with_transfer_fees() {
    use anchor_spl::token_2022::spl_token_2022::{
        extension::{transfer_fee::instruction::initialize_transfer_fee_config, ExtensionType},
        instruction::initialize_mint2,
        state::Mint as MintState,
    };
    let mut env = Env::new(TOKEN_2022);
    let admin = env.admin.insecure_clone();
    env.init_config(&admin, 0).unwrap();
    let mint = Keypair::new();
    let len = ExtensionType::try_calculate_account_len::<MintState>(&[ExtensionType::TransferFeeConfig]).unwrap();
    let ixs = [
        solana_system_interface::instruction::create_account(
            &admin.pubkey(), &mint.pubkey(), env.svm.minimum_balance_for_rent_exemption(len), len as u64, &TOKEN_2022),
        initialize_transfer_fee_config(&TOKEN_2022, &mint.pubkey(), None, None, 100, 1_000).unwrap(),
        initialize_mint2(&TOKEN_2022, &mint.pubkey(), &admin.pubkey(), None, 6).unwrap(),
    ];
    env.send(&ixs, &[&admin, &mint]).unwrap();
    env.mint = mint.pubkey();
    expect_err(env.set_mint(true), "UnsafeMint");
    // Blocking a mint is always allowed.
    env.set_mint(false).unwrap();
}
