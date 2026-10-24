-- LatiumX Phase 2: escrows mirrored from the chain. The chain is the source of truth; this table
-- is a cache so the site can list escrows without scanning the chain.

CREATE TABLE escrows (
  address           TEXT PRIMARY KEY,                -- escrow account (PDA)
  client_wallet     TEXT NOT NULL,
  freelancer_wallet TEXT NOT NULL,
  mint              TEXT NOT NULL,
  amount            TEXT NOT NULL,                   -- raw token units (u64 as text)
  fee_bps           INTEGER NOT NULL,
  ref_kind          INTEGER NOT NULL,                -- 0 direct, 1 project, 2 gig
  ref_id            INTEGER NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('funded', 'delivered', 'disputed', 'released', 'refunded', 'resolved')),
  outcome           TEXT NOT NULL DEFAULT '',        -- JSON with payout amounts once settled
  created_at        INTEGER NOT NULL,                -- on-chain time
  delivery_deadline INTEGER NOT NULL,
  review_seconds    INTEGER NOT NULL,
  delivered_at      INTEGER NOT NULL DEFAULT 0,
  last_signature    TEXT NOT NULL DEFAULT '',
  synced_at         INTEGER NOT NULL
);
CREATE INDEX escrows_client ON escrows (client_wallet, created_at DESC);
CREATE INDEX escrows_freelancer ON escrows (freelancer_wallet, created_at DESC);
CREATE INDEX escrows_ref ON escrows (ref_kind, ref_id);
CREATE INDEX escrows_state ON escrows (state, synced_at DESC);
