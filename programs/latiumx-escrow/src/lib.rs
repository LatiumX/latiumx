//! LatiumX Freelancing escrow.
//!
//! A client locks an SPL token payment for one job. The money sits in a vault owned by the
//! escrow account, so neither side can move it alone:
//!
//! - the client releases it to the freelancer (any time before a dispute),
//! - the freelancer refunds it to the client (any time before a dispute),
//! - after the freelancer marks the job delivered and the review period passes, the freelancer
//!   can claim it,
//! - if the freelancer never delivers by the deadline, the client can take it back,
//! - either side can open a dispute, which freezes all of the above until the arbiter splits it.
//!
//! The platform fee is taken only from the freelancer's share and is fixed when the escrow is
//! funded. Only mints the admin has allowed can be used. Pausing only stops new escrows; it never
//! blocks money that is already locked.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    close_account, transfer_checked, CloseAccount, Mint, TokenAccount, TokenInterface,
    TransferChecked,
};

declare_id!("G48Xix7oG6FL7hMArJgGyc5qtvjn3BX5BF21x3LYqGbN");

pub const CONFIG_SEED: &[u8] = b"config";
pub const MINT_SEED: &[u8] = b"mint";
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const VAULT_SEED: &[u8] = b"vault";

pub const BPS: u64 = 10_000;
pub const MAX_FEE_BPS: u16 = 1_000; // 10%
pub const DAY: i64 = 86_400;
pub const MIN_REVIEW: i64 = DAY;
pub const MAX_REVIEW: i64 = 30 * DAY;
pub const MIN_DELIVERY: i64 = DAY;
pub const MAX_DELIVERY: i64 = 365 * DAY;

#[program]
pub mod latiumx_escrow {
    use super::*;

    /// One time setup. Only the program's upgrade authority can call it, so nobody can
    /// front-run the deployer and take the admin role.
    pub fn init_config(
        ctx: Context<InitConfig>,
        arbiter: Pubkey,
        fee_recipient: Pubkey,
        fee_bps: u16,
    ) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, EscrowError::FeeTooHigh);
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.arbiter = arbiter;
        config.fee_recipient = fee_recipient;
        config.fee_bps = fee_bps;
        config.paused = false;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn update_config(
        ctx: Context<AdminOnly>,
        arbiter: Pubkey,
        fee_recipient: Pubkey,
        fee_bps: u16,
        paused: bool,
    ) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, EscrowError::FeeTooHigh);
        let config = &mut ctx.accounts.config;
        config.arbiter = arbiter;
        config.fee_recipient = fee_recipient;
        config.fee_bps = fee_bps;
        config.paused = paused;
        emit!(ConfigUpdated { arbiter, fee_recipient, fee_bps, paused });
        Ok(())
    }

    /// Two-step admin handover so a typo can't lock the admin role away.
    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_admin = new_admin;
        Ok(())
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = config.pending_admin;
        config.pending_admin = Pubkey::default();
        Ok(())
    }

    /// Allows or blocks a token for new escrows. Token-2022 mints with extensions that could
    /// freeze, skim or claw back the vault (transfer fees, hooks, permanent delegates, default
    /// frozen accounts, ...) are refused.
    pub fn set_mint(ctx: Context<SetMint>, enabled: bool) -> Result<()> {
        if enabled {
            check_mint_extensions(&ctx.accounts.mint.to_account_info())?;
        }
        let allowed = &mut ctx.accounts.allowed_mint;
        allowed.mint = ctx.accounts.mint.key();
        allowed.enabled = enabled;
        allowed.bump = ctx.bumps.allowed_mint;
        Ok(())
    }

    /// The client funds a new escrow. `id` is chosen by the client and only has to be unique
    /// among that client's escrows. `ref_kind`/`ref_id` point at the LatiumX project or gig.
    #[allow(clippy::too_many_arguments)]
    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        id: u64,
        amount: u64,
        delivery_seconds: i64,
        review_seconds: i64,
        ref_kind: u8,
        ref_id: u64,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, EscrowError::Paused);
        require!(ctx.accounts.allowed_mint.enabled, EscrowError::MintNotAllowed);
        require!(amount > 0, EscrowError::ZeroAmount);
        require_keys_neq!(ctx.accounts.client.key(), ctx.accounts.freelancer.key(), EscrowError::SelfEscrow);
        require!((MIN_DELIVERY..=MAX_DELIVERY).contains(&delivery_seconds), EscrowError::BadPeriod);
        require!((MIN_REVIEW..=MAX_REVIEW).contains(&review_seconds), EscrowError::BadPeriod);
        require!(ref_kind <= 2, EscrowError::BadReference);

        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.client_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.client.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        // Token-2022 mints can take a fee on transfer, so record what actually arrived.
        ctx.accounts.vault.reload()?;
        let received = ctx.accounts.vault.amount;
        require!(received > 0, EscrowError::ZeroAmount);

        let now = Clock::get()?.unix_timestamp;
        let escrow = &mut ctx.accounts.escrow;
        escrow.client = ctx.accounts.client.key();
        escrow.freelancer = ctx.accounts.freelancer.key();
        escrow.mint = ctx.accounts.mint.key();
        escrow.fee_recipient = config.fee_recipient;
        escrow.id = id;
        escrow.amount = received;
        escrow.fee_bps = config.fee_bps;
        escrow.ref_kind = ref_kind;
        escrow.ref_id = ref_id;
        escrow.state = EscrowState::Funded;
        escrow.created_at = now;
        escrow.delivery_deadline = now + delivery_seconds;
        escrow.review_seconds = review_seconds;
        escrow.delivered_at = 0;
        escrow.bump = ctx.bumps.escrow;
        escrow.vault_bump = ctx.bumps.vault;

        emit!(EscrowFunded {
            escrow: escrow.key(),
            client: escrow.client,
            freelancer: escrow.freelancer,
            mint: escrow.mint,
            amount: received,
            ref_kind,
            ref_id,
        });
        Ok(())
    }

    pub fn mark_delivered(ctx: Context<FreelancerAction>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == EscrowState::Funded, EscrowError::WrongState);
        escrow.state = EscrowState::Delivered;
        escrow.delivered_at = Clock::get()?.unix_timestamp;
        emit!(EscrowDelivered { escrow: escrow.key() });
        Ok(())
    }

    /// The client is happy and pays the freelancer.
    pub fn release(ctx: Context<Settle>) -> Result<()> {
        require_keys_eq!(ctx.accounts.signer.key(), ctx.accounts.escrow.client, EscrowError::NotClient);
        let state = ctx.accounts.escrow.state;
        require!(matches!(state, EscrowState::Funded | EscrowState::Delivered), EscrowError::WrongState);
        let amount = ctx.accounts.escrow.amount;
        settle(ctx, amount, Outcome::Released)
    }

    /// The client didn't respond within the review period after delivery.
    pub fn claim(ctx: Context<Settle>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require_keys_eq!(ctx.accounts.signer.key(), escrow.freelancer, EscrowError::NotFreelancer);
        require!(escrow.state == EscrowState::Delivered, EscrowError::WrongState);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= escrow.delivered_at + escrow.review_seconds, EscrowError::TooEarly);
        let amount = escrow.amount;
        settle(ctx, amount, Outcome::Claimed)
    }

    /// The freelancer cancels and gives the money back. No fee.
    pub fn refund(ctx: Context<Settle>) -> Result<()> {
        require_keys_eq!(ctx.accounts.signer.key(), ctx.accounts.escrow.freelancer, EscrowError::NotFreelancer);
        let state = ctx.accounts.escrow.state;
        require!(matches!(state, EscrowState::Funded | EscrowState::Delivered), EscrowError::WrongState);
        settle(ctx, 0, Outcome::Refunded)
    }

    /// The freelancer never marked the job delivered and the deadline has passed.
    pub fn reclaim(ctx: Context<Settle>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require_keys_eq!(ctx.accounts.signer.key(), escrow.client, EscrowError::NotClient);
        require!(escrow.state == EscrowState::Funded, EscrowError::WrongState);
        let now = Clock::get()?.unix_timestamp;
        require!(now > escrow.delivery_deadline, EscrowError::TooEarly);
        settle(ctx, 0, Outcome::Reclaimed)
    }

    pub fn open_dispute(ctx: Context<PartyAction>) -> Result<()> {
        let signer = ctx.accounts.signer.key();
        let escrow = &mut ctx.accounts.escrow;
        require!(signer == escrow.client || signer == escrow.freelancer, EscrowError::NotParty);
        require!(matches!(escrow.state, EscrowState::Funded | EscrowState::Delivered), EscrowError::WrongState);
        escrow.state = EscrowState::Disputed;
        emit!(EscrowDisputed { escrow: escrow.key(), by: signer });
        Ok(())
    }

    /// The arbiter splits a disputed escrow. `freelancer_bps` is the freelancer's share out of
    /// 10,000; the rest goes back to the client.
    pub fn resolve(ctx: Context<Settle>, freelancer_bps: u16) -> Result<()> {
        require_keys_eq!(ctx.accounts.signer.key(), ctx.accounts.config.arbiter, EscrowError::NotArbiter);
        require!(ctx.accounts.escrow.state == EscrowState::Disputed, EscrowError::WrongState);
        require!(u64::from(freelancer_bps) <= BPS, EscrowError::BadSplit);
        let to_freelancer = mul_bps(ctx.accounts.escrow.amount, freelancer_bps)?;
        settle(ctx, to_freelancer, Outcome::Resolved)
    }
}

#[derive(Clone, Copy)]
enum Outcome {
    Released,
    Claimed,
    Refunded,
    Reclaimed,
    Resolved,
}

fn check_mint_extensions(mint: &AccountInfo) -> Result<()> {
    use anchor_spl::token_2022::spl_token_2022::{
        extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
        state::Mint as MintState,
    };
    if mint.owner != &anchor_spl::token_2022::ID {
        return Ok(());
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<MintState>::unpack(&data).map_err(|_| error!(EscrowError::UnsafeMint))?;
    let types = state.get_extension_types().map_err(|_| error!(EscrowError::UnsafeMint))?;
    for t in types {
        match t {
            ExtensionType::MetadataPointer
            | ExtensionType::TokenMetadata
            | ExtensionType::GroupPointer
            | ExtensionType::TokenGroup
            | ExtensionType::GroupMemberPointer
            | ExtensionType::TokenGroupMember
            | ExtensionType::MintCloseAuthority => {}
            _ => return err!(EscrowError::UnsafeMint),
        }
    }
    Ok(())
}

fn mul_bps(amount: u64, bps: u16) -> Result<u64> {
    let v = (amount as u128) * (bps as u128) / (BPS as u128);
    u64::try_from(v).map_err(|_| error!(EscrowError::MathOverflow))
}

/// Pays `to_freelancer_gross` (less the fee) to the freelancer and everything else in the vault
/// to the client, then closes the vault and the escrow account. Rent goes back to the client,
/// who paid it. Tokens sent straight to the vault by anyone else also end up with the client.
fn settle(ctx: Context<Settle>, to_freelancer_gross: u64, outcome: Outcome) -> Result<()> {
    let a = ctx.accounts;
    let escrow = &a.escrow;
    let in_vault = a.vault.amount;
    require!(to_freelancer_gross <= escrow.amount && escrow.amount <= in_vault, EscrowError::MathOverflow);
    let fee = mul_bps(to_freelancer_gross, escrow.fee_bps)?;
    let to_freelancer = to_freelancer_gross - fee;
    let to_client = in_vault - to_freelancer_gross;

    let client_key = escrow.client;
    let id_bytes = escrow.id.to_le_bytes();
    let bump = [escrow.bump];
    let seeds: &[&[u8]] = &[ESCROW_SEED, client_key.as_ref(), &id_bytes, &bump];
    let signer: &[&[&[u8]]] = &[seeds];

    pay_out(a, a.freelancer_token.to_account_info(), to_freelancer, signer)?;
    pay_out(a, a.fee_token.to_account_info(), fee, signer)?;
    pay_out(a, a.client_token.to_account_info(), to_client, signer)?;
    close_account(CpiContext::new_with_signer(
        a.token_program.key(),
        CloseAccount {
            account: a.vault.to_account_info(),
            destination: a.client.to_account_info(),
            authority: a.escrow.to_account_info(),
        },
        signer,
    ))?;

    let key = a.escrow.key();
    match outcome {
        Outcome::Released | Outcome::Claimed => emit!(EscrowReleased {
            escrow: key,
            to_freelancer,
            fee,
            by_claim: matches!(outcome, Outcome::Claimed),
        }),
        Outcome::Refunded | Outcome::Reclaimed => emit!(EscrowRefunded {
            escrow: key,
            to_client,
            by_freelancer: matches!(outcome, Outcome::Refunded),
        }),
        Outcome::Resolved => emit!(EscrowResolved { escrow: key, to_freelancer, to_client, fee }),
    }
    // The escrow account itself is closed by the `close = client` constraint.
    Ok(())
}

fn pay_out<'info>(a: &Settle<'info>, to: AccountInfo<'info>, amount: u64, signer: &[&[&[u8]]]) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.key(),
            TransferChecked {
                from: a.vault.to_account_info(),
                mint: a.mint.to_account_info(),
                to,
                authority: a.escrow.to_account_info(),
            },
            signer,
        ),
        amount,
        a.mint.decimals,
    )
}

// ---------------------------------------------------------------- accounts

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub arbiter: Pubkey,
    pub fee_recipient: Pubkey,
    pub fee_bps: u16,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct AllowedMint {
    pub mint: Pubkey,
    pub enabled: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum EscrowState {
    Funded,
    Delivered,
    Disputed,
}

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub client: Pubkey,
    pub freelancer: Pubkey,
    pub mint: Pubkey,
    pub fee_recipient: Pubkey,
    pub id: u64,
    pub amount: u64,
    pub fee_bps: u16,
    pub ref_kind: u8,
    pub ref_id: u64,
    pub state: EscrowState,
    pub created_at: i64,
    pub delivery_deadline: i64,
    pub review_seconds: i64,
    pub delivered_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ EscrowError::NotUpgradeAuthority)]
    pub program: Program<'info, crate::program::LatiumxEscrow>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ EscrowError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ EscrowError::NotAdmin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump,
        constraint = config.pending_admin == new_admin.key() @ EscrowError::NotAdmin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct SetMint<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ EscrowError::NotAdmin)]
    pub config: Account<'info, Config>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init_if_needed, payer = admin, space = 8 + AllowedMint::INIT_SPACE,
        seeds = [MINT_SEED, mint.key().as_ref()], bump)]
    pub allowed_mint: Account<'info, AllowedMint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    /// CHECK: any wallet can be paid; it only receives tokens.
    pub freelancer: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(seeds = [MINT_SEED, mint.key().as_ref()], bump = allowed_mint.bump)]
    pub allowed_mint: Account<'info, AllowedMint>,
    #[account(init, payer = client, space = 8 + Escrow::INIT_SPACE,
        seeds = [ESCROW_SEED, client.key().as_ref(), &id.to_le_bytes()], bump)]
    pub escrow: Account<'info, Escrow>,
    #[account(init, payer = client, seeds = [VAULT_SEED, escrow.key().as_ref()], bump,
        token::mint = mint, token::authority = escrow, token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = client, token::token_program = token_program)]
    pub client_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FreelancerAction<'info> {
    pub freelancer: Signer<'info>,
    #[account(mut, has_one = freelancer @ EscrowError::NotFreelancer,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow.id.to_le_bytes()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
pub struct PartyAction<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow.id.to_le_bytes()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,
}

/// Shared by every instruction that pays out and closes an escrow. Who may sign is checked in
/// each instruction; the signer pays for any token account that has to be created.
#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, close = client,
        has_one = client, has_one = freelancer, has_one = mint, has_one = fee_recipient,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow.id.to_le_bytes()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, seeds = [VAULT_SEED, escrow.key().as_ref()], bump = escrow.vault_bump,
        token::mint = mint, token::authority = escrow, token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: checked against escrow.client; receives rent and refunds.
    #[account(mut)]
    pub client: UncheckedAccount<'info>,
    /// CHECK: checked against escrow.freelancer.
    pub freelancer: UncheckedAccount<'info>,
    /// CHECK: checked against escrow.fee_recipient.
    pub fee_recipient: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = signer,
        associated_token::mint = mint, associated_token::authority = client, associated_token::token_program = token_program)]
    pub client_token: InterfaceAccount<'info, TokenAccount>,
    #[account(init_if_needed, payer = signer,
        associated_token::mint = mint, associated_token::authority = freelancer, associated_token::token_program = token_program)]
    pub freelancer_token: InterfaceAccount<'info, TokenAccount>,
    #[account(init_if_needed, payer = signer,
        associated_token::mint = mint, associated_token::authority = fee_recipient, associated_token::token_program = token_program)]
    pub fee_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------- events and errors

#[event]
pub struct ConfigUpdated {
    pub arbiter: Pubkey,
    pub fee_recipient: Pubkey,
    pub fee_bps: u16,
    pub paused: bool,
}

#[event]
pub struct EscrowFunded {
    pub escrow: Pubkey,
    pub client: Pubkey,
    pub freelancer: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub ref_kind: u8,
    pub ref_id: u64,
}

#[event]
pub struct EscrowDelivered {
    pub escrow: Pubkey,
}

#[event]
pub struct EscrowDisputed {
    pub escrow: Pubkey,
    pub by: Pubkey,
}

#[event]
pub struct EscrowReleased {
    pub escrow: Pubkey,
    pub to_freelancer: u64,
    pub fee: u64,
    pub by_claim: bool,
}

#[event]
pub struct EscrowRefunded {
    pub escrow: Pubkey,
    pub to_client: u64,
    pub by_freelancer: bool,
}

#[event]
pub struct EscrowResolved {
    pub escrow: Pubkey,
    pub to_freelancer: u64,
    pub to_client: u64,
    pub fee: u64,
}

#[error_code]
pub enum EscrowError {
    #[msg("Only the program's upgrade authority can set up the config")]
    NotUpgradeAuthority,
    #[msg("Only the admin can do this")]
    NotAdmin,
    #[msg("Fee is above the 10% cap")]
    FeeTooHigh,
    #[msg("New escrows are paused")]
    Paused,
    #[msg("This token is not allowed for escrow")]
    MintNotAllowed,
    #[msg("Amount must be more than zero")]
    ZeroAmount,
    #[msg("Client and freelancer must be different wallets")]
    SelfEscrow,
    #[msg("Delivery or review period is out of range")]
    BadPeriod,
    #[msg("Unknown reference kind")]
    BadReference,
    #[msg("The escrow is not in the right state for this")]
    WrongState,
    #[msg("Only the client can do this")]
    NotClient,
    #[msg("Only the freelancer can do this")]
    NotFreelancer,
    #[msg("Only the client or the freelancer can do this")]
    NotParty,
    #[msg("Only the arbiter can do this")]
    NotArbiter,
    #[msg("Too early")]
    TooEarly,
    #[msg("Split must be between 0 and 10000")]
    BadSplit,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("This token has Token-2022 extensions that are not safe for escrow")]
    UnsafeMint,
}
