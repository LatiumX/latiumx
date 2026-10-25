-- Bug reports from users. The reporter's wallet is kept so the team can send a reward.
-- The API also creates this table on first use, so running this by hand is optional.
CREATE TABLE IF NOT EXISTS bug_reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_wallet TEXT NOT NULL,
  title           TEXT NOT NULL,
  details         TEXT NOT NULL,
  page            TEXT NOT NULL DEFAULT '',
  user_agent      TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'confirmed', 'rewarded', 'rejected')),
  admin_note      TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bug_reports_status ON bug_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS bug_reports_reporter ON bug_reports (reporter_wallet, created_at DESC);
