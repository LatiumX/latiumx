-- Friends and blocking. The API also creates these tables on first use, so running this by hand is optional.
CREATE TABLE IF NOT EXISTS friendships (
  requester  TEXT NOT NULL,
  addressee  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (requester, addressee)
);
CREATE INDEX IF NOT EXISTS friendships_addressee ON friendships (addressee, status);
CREATE INDEX IF NOT EXISTS friendships_requester ON friendships (requester, status);

CREATE TABLE IF NOT EXISTS blocks (
  blocker    TEXT NOT NULL,
  blocked    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker, blocked)
);
CREATE INDEX IF NOT EXISTS blocks_blocked ON blocks (blocked);
