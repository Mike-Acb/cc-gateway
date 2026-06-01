-- Add `recommended` flag on plans. Drives the "推荐" badge on the
-- /plans page so ops can toggle it from the admin UI instead of
-- relying on the hard-coded "first monthly pool" heuristic.

ALTER TABLE plans ADD COLUMN IF NOT EXISTS recommended BOOLEAN NOT NULL DEFAULT false;
