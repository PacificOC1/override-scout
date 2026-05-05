-- ============================================================
--  OVERRIDE AUTONOMOUS SCOUT — Supabase SQL Setup
--  Run this entire file in: Supabase → SQL Editor → New Query
-- ============================================================


-- ── STEP 1: Create the main entries table ──────────────────
CREATE TABLE IF NOT EXISTS entries (
  id          BIGINT        PRIMARY KEY,        -- unique ID (from app timestamp)
  team        TEXT          NOT NULL,           -- team number e.g. "73017D"
  event       TEXT          DEFAULT '',        -- event name
  round       TEXT          DEFAULT '',        -- match round e.g. "R16 1-1"
  side        TEXT          DEFAULT 'L',       -- L or R
  sig         TEXT          DEFAULT 'no',      -- 'yes' if Sig/Worlds qualifier
  type        TEXT          DEFAULT '',        -- robot type
  route       TEXT          DEFAULT 'Unknown route',
  pins        TEXT          DEFAULT '0',       -- format: "A+B+C"
  maxpins     TEXT          DEFAULT '',        -- max possible pins if known
  bonuses     INTEGER       DEFAULT 0,
  awp         TEXT          DEFAULT 'N',       -- 'Y', 'N', or '?'
  notes       TEXT          DEFAULT '',
  ts          TEXT          DEFAULT '',        -- date string
  created_at  TIMESTAMPTZ   DEFAULT NOW()
);


-- ── STEP 2: Enable Row Level Security ─────────────────────
--  This controls who can read/write data.
ALTER TABLE entries ENABLE ROW LEVEL SECURITY;


-- ── STEP 3: Allow anyone to READ (public search page) ─────
CREATE POLICY "Public read access"
  ON entries
  FOR SELECT
  USING (true);


-- ── STEP 4: Allow your app to INSERT new entries ──────────
--  The anon key can insert — but NOT delete or update.
--  This means your scouting app can push data, but
--  random people visiting the site cannot modify anything.
CREATE POLICY "App can insert entries"
  ON entries
  FOR INSERT
  WITH CHECK (true);


-- ── STEP 5: Create a view for team stats (used by search) ─
--  This pre-calculates per-team averages so the search
--  widget doesn't have to do heavy math in the browser.
CREATE OR REPLACE VIEW team_stats AS
SELECT
  team,
  COUNT(*)                                          AS match_count,
  ROUND(AVG(
    COALESCE(SPLIT_PART(pins,'+',1)::INTEGER, 0)
  + COALESCE(SPLIT_PART(pins,'+',2)::INTEGER, 0)
  + COALESCE(SPLIT_PART(pins,'+',3)::INTEGER, 0)
  ), 2)                                             AS avg_pins,
  ROUND(AVG(bonuses), 2)                            AS avg_bonuses,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE awp = 'Y') / COUNT(*)
  , 1)                                              AS awp_rate_pct,
  COUNT(*) FILTER (WHERE awp = 'Y')                 AS awp_count,
  COUNT(*) FILTER (WHERE sig = 'yes')               AS sig_matches,
  STRING_AGG(DISTINCT route, ' · '
    ORDER BY route)                                 AS known_routes,
  STRING_AGG(DISTINCT type,  ', '
    ORDER BY type)                                  AS robot_types,
  MAX(created_at)                                   AS last_seen
FROM entries
GROUP BY team;


-- ── STEP 6: Allow public to read the stats view ───────────
CREATE POLICY "Public read team_stats"
  ON entries
  FOR SELECT
  USING (true);
-- (Views inherit table policies — the SELECT policy above covers it)


-- ── STEP 7: Create indexes for fast search ────────────────
CREATE INDEX IF NOT EXISTS idx_entries_team
  ON entries (UPPER(team));

CREATE INDEX IF NOT EXISTS idx_entries_sig
  ON entries (sig);

CREATE INDEX IF NOT EXISTS idx_entries_awp
  ON entries (awp);

CREATE INDEX IF NOT EXISTS idx_entries_created
  ON entries (created_at DESC);


-- ── DONE ──────────────────────────────────────────────────
-- You should see the "entries" table and "team_stats" view
-- appear in your Supabase Table Editor on the left.
--
-- Next step: copy your Project URL and anon key from
-- Supabase → Project Settings → API
-- and paste them into the search widget HTML file.
-- ============================================================
