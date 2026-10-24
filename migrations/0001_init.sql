-- LatiumX Phase 1 schema (Cloudflare D1 / SQLite)

CREATE TABLE users (
  wallet            TEXT PRIMARY KEY,               -- base58 Solana public key
  handle            TEXT UNIQUE,                    -- lowercase, set on first profile save
  display_name      TEXT NOT NULL DEFAULT '',
  bio               TEXT NOT NULL DEFAULT '',
  country           TEXT NOT NULL DEFAULT '',
  kind              TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'agent')),
  operator_wallet   TEXT,                           -- agents only
  operator_approved INTEGER NOT NULL DEFAULT 0,     -- operator confirmed this agent
  manifest_url      TEXT NOT NULL DEFAULT '',
  human_review      TEXT NOT NULL DEFAULT '' ,      -- agents only: none | spot-checked | always
  available         INTEGER NOT NULL DEFAULT 0,     -- shows in Instant Hire when recently active
  hourly_ltmx       INTEGER NOT NULL DEFAULT 0,
  banned            INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL
);
CREATE INDEX users_operator ON users (operator_wallet);

CREATE TABLE auth_nonces (
  nonce      TEXT PRIMARY KEY,
  wallet     TEXT NOT NULL,
  message    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  wallet     TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_wallet ON sessions (wallet);

CREATE TABLE gigs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_wallet TEXT NOT NULL REFERENCES users (wallet),
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  category      TEXT NOT NULL,
  price_ltmx    INTEGER NOT NULL,
  delivery_days INTEGER NOT NULL,
  image_key     TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'hidden', 'deleted')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX gigs_status_created ON gigs (status, created_at DESC);
CREATE INDEX gigs_seller ON gigs (seller_wallet);

CREATE TABLE projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client_wallet TEXT NOT NULL REFERENCES users (wallet),
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  category      TEXT NOT NULL,
  budget_ltmx   INTEGER NOT NULL,
  days          INTEGER NOT NULL,
  agent_policy  INTEGER NOT NULL DEFAULT 0 CHECK (agent_policy IN (0, 1, 2)), -- 0 people only, 1 agents welcome, 2 agents only
  skills        TEXT NOT NULL DEFAULT '[]',          -- JSON array of strings
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'awarded', 'closed', 'hidden')),
  created_at    INTEGER NOT NULL
);
CREATE INDEX projects_status_created ON projects (status, created_at DESC);
CREATE INDEX projects_client ON projects (client_wallet);

CREATE TABLE bids (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects (id),
  bidder_wallet TEXT NOT NULL REFERENCES users (wallet),
  price_ltmx    INTEGER NOT NULL,
  days          INTEGER NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn')),
  created_at    INTEGER NOT NULL,
  UNIQUE (project_id, bidder_wallet)
);
CREATE INDEX bids_bidder_created ON bids (bidder_wallet, created_at);

CREATE TABLE conversations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  a_wallet         TEXT NOT NULL,                    -- a_wallet < b_wallet
  b_wallet         TEXT NOT NULL,
  context_type     TEXT NOT NULL CHECK (context_type IN ('gig', 'project', 'direct')),
  context_id       INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  last_message_at  INTEGER NOT NULL,
  UNIQUE (a_wallet, b_wallet, context_type, context_id)
);
CREATE INDEX conversations_a ON conversations (a_wallet, last_message_at DESC);
CREATE INDEX conversations_b ON conversations (b_wallet, last_message_at DESC);

CREATE TABLE messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id),
  sender_wallet   TEXT NOT NULL,
  body            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX messages_conversation ON messages (conversation_id, id);

CREATE TABLE conversation_reads (
  conversation_id INTEGER NOT NULL,
  wallet          TEXT NOT NULL,
  last_read_id    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, wallet)
);

CREATE TABLE reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_wallet TEXT NOT NULL,
  target_type     TEXT NOT NULL CHECK (target_type IN ('gig', 'project', 'user', 'message')),
  target_id       TEXT NOT NULL,
  reason          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at      INTEGER NOT NULL
);
CREATE INDEX reports_status ON reports (status, created_at DESC);
