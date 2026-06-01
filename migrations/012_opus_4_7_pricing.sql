-- Refresh Claude model pricing to match Anthropic public rates as of 2026-04-16.
-- Source: https://platform.claude.com/docs/en/about-claude/pricing
--
-- New rows are added with today's effective_from so historical invoices
-- continue using the old rate (billing.ts looks up the latest row with
-- effective_from <= period_end).
--
--                  Base In    5m Cache Wr   Cache Hit   Output
-- Opus 4.7         $5.00      $6.25         $0.50       $25.00
-- Opus 4.6         $5.00      $6.25         $0.50       $25.00   (was $15/$75/$1.50/$18.75 — Opus 4.1-era price)
-- Haiku 4.5        $1.00      $1.25         $0.10       $5.00    (was $0.80/$4/$0.08/$1 — Haiku 3.5 values)
--
-- Note: Opus 4.7 uses a new tokenizer that may consume up to ~35% more
-- tokens for the same text compared to earlier models.

INSERT INTO model_pricing
  (model_pattern,    input_mtok, output_mtok, cache_read_mtok, cache_write_mtok, effective_from) VALUES
  ('claude-opus-4-7',   5.00,       25.00,       0.50,            6.25,             CURRENT_DATE),
  ('claude-opus-4-6',   5.00,       25.00,       0.50,            6.25,             CURRENT_DATE),
  ('claude-haiku-4-5',  1.00,        5.00,       0.10,            1.25,             CURRENT_DATE)
ON CONFLICT (model_pattern, effective_from) DO UPDATE SET
  input_mtok       = EXCLUDED.input_mtok,
  output_mtok      = EXCLUDED.output_mtok,
  cache_read_mtok  = EXCLUDED.cache_read_mtok,
  cache_write_mtok = EXCLUDED.cache_write_mtok;
