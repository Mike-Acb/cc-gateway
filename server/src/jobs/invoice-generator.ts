import cron from 'node-cron'
import { generateMonthlyInvoices } from '../services/billing.js'

export function startInvoiceGenerator(): void {
  // Run at 00:05 on the 1st of every month
  cron.schedule('5 0 1 * *', async () => {
    console.log('[JOB] Generating monthly invoices...')
    const lastMonth = new Date()
    lastMonth.setMonth(lastMonth.getMonth() - 1)
    const periodStart = new Date(lastMonth.getFullYear(), lastMonth.getMonth(), 1)
    const periodEnd = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, 0) // last day of prev month

    try {
      const count = await generateMonthlyInvoices(periodStart, periodEnd)
      console.log(`[JOB] Generated ${count} invoices for ${periodStart.toISOString().slice(0, 7)}`)
    } catch (err) {
      console.error('[JOB] Invoice generation failed:', err)
    }
  })
  console.log('Invoice generator scheduled: 00:05 on 1st of each month')
}
