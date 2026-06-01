import { query } from './db.js'
import { log } from './logger.js'

/**
 * Ensures usage_records partitions exist for the current and next month.
 * Safe to call multiple times — uses IF NOT EXISTS.
 */
export async function ensurePartitions(): Promise<void> {
  try {
    await query(`
      DO $$
      DECLARE
        cur_start DATE := date_trunc('month', CURRENT_DATE);
        cur_end   DATE := cur_start + INTERVAL '1 month';
        nxt_start DATE := cur_end;
        nxt_end   DATE := nxt_start + INTERVAL '1 month';
        cur_name  TEXT := 'usage_records_' || to_char(cur_start, 'YYYY_MM');
        nxt_name  TEXT := 'usage_records_' || to_char(nxt_start, 'YYYY_MM');
      BEGIN
        EXECUTE format(
          'CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_records FOR VALUES FROM (%L) TO (%L)',
          cur_name, cur_start, cur_end
        );
        EXECUTE format(
          'CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_records FOR VALUES FROM (%L) TO (%L)',
          nxt_name, nxt_start, nxt_end
        );
      END $$;
    `)
    log('info', 'Usage record partitions verified')
  } catch (err) {
    log('error', `Failed to ensure partitions: ${err}`)
  }
}
