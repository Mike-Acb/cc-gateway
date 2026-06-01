import cron from 'node-cron'
import { query, DEPLOYMENT } from '../db.js'
import { createNotification } from '../services/notification.js'

export function startOverdueChecker(): void {
  // Run daily at 09:00
  cron.schedule('0 9 * * *', async () => {
    console.log('[JOB] Checking for overdue invoices...')
    try {
      // Mark overdue invoices
      const overdue = await query(
        `UPDATE invoices SET status = 'overdue'
         WHERE status = 'issued' AND due_date < CURRENT_DATE
         RETURNING id, user_id, total_due, due_date`,
      )

      for (const inv of overdue.rows) {
        await createNotification(
          inv.user_id,
          'invoice',
          '账单已逾期',
          `您的账单 ¥${inv.total_due} 已逾期，请尽快支付。`,
        )
      }

      // Suspend clients for users with invoices overdue > 3 days (grace period)
      const toSuspend = await query(
        `SELECT DISTINCT i.user_id FROM invoices i
         WHERE i.status = 'overdue' AND i.due_date < CURRENT_DATE - INTERVAL '3 days'
         AND EXISTS (SELECT 1 FROM clients c WHERE c.user_id = i.user_id AND c.status = 'active' AND c.deployment = $1)`,
        [DEPLOYMENT],
      )

      for (const row of toSuspend.rows) {
        await query(
          `UPDATE clients SET status = 'suspended', suspended_at = now(), suspend_reason = 'unpaid', updated_at = now()
           WHERE user_id = $1 AND status = 'active' AND deployment = $2`,
          [row.user_id, DEPLOYMENT],
        )
        await createNotification(
          row.user_id,
          'suspend',
          '客户端已停用',
          '由于账单逾期未支付，您的所有客户端已被停用。请支付后自动恢复。',
        )
      }

      console.log(
        `[JOB] Marked ${overdue.rows.length} invoices overdue, suspended ${toSuspend.rows.length} users' clients`,
      )
    } catch (err) {
      console.error('[JOB] Overdue check failed:', err)
    }
  })
  console.log('Overdue checker scheduled: daily at 09:00')
}
