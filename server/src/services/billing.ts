import { query, pool, DEPLOYMENT } from '../db.js'

/**
 * Generate monthly invoices for all users with usage in the given period.
 */
export async function generateMonthlyInvoices(
  periodStart: Date,
  periodEnd: Date,
): Promise<number> {
  // 1. Find all users with active clients that have usage in the period
  const usersResult = await query(
    `SELECT DISTINCT u.id AS user_id, u.discount_rate, u.free_until
     FROM users u
     JOIN clients c ON c.user_id = u.id AND c.status = 'active'
     JOIN usage_records ur ON ur.client_id = c.id
     WHERE ur.created_at >= $1 AND ur.created_at < $2
       AND u.deployment = $3 AND c.deployment = $3`,
    [periodStart, periodEnd, DEPLOYMENT],
  )

  if (usersResult.rows.length === 0) return 0

  // Pre-fetch total tokens across ALL users for cost-share calculation
  const allTokensResult = await query(
    `SELECT COALESCE(SUM(input_tokens::bigint + output_tokens::bigint + cache_read::bigint + cache_write::bigint), 0) AS total
     FROM usage_records ur
     JOIN clients c ON c.id = ur.client_id AND c.status = 'active'
     WHERE ur.created_at >= $1 AND ur.created_at < $2
       AND c.deployment = $3`,
    [periodStart, periodEnd, DEPLOYMENT],
  )
  const allTokensTotal = BigInt(allTokensResult.rows[0].total)

  // Pre-fetch daily cost total for the period
  const dailyCostResult = await query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM daily_costs
     WHERE date >= $1 AND date <= $2`,
    [periodStart, periodEnd],
  )
  const totalDailyCost = Number(dailyCostResult.rows[0].total)

  // Due date = periodEnd + 15 days
  const dueDate = new Date(periodEnd)
  dueDate.setDate(dueDate.getDate() + 15)

  let invoiceCount = 0

  for (const user of usersResult.rows) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const userId: string = user.user_id
      const discountRate: number = Number(user.discount_rate ?? 1)
      const freeUntil: Date | null = user.free_until ? new Date(user.free_until) : null

      // 2a. Usage grouped by model
      const usageByModel = await client.query(
        `SELECT
           ur.model,
           COALESCE(SUM(ur.input_tokens), 0)::bigint  AS input_tokens,
           COALESCE(SUM(ur.output_tokens), 0)::bigint AS output_tokens,
           COALESCE(SUM(ur.cache_read), 0)::bigint    AS cache_read,
           COALESCE(SUM(ur.cache_write), 0)::bigint   AS cache_write
         FROM usage_records ur
         JOIN clients c ON c.id = ur.client_id AND c.user_id = $1
         WHERE ur.created_at >= $2 AND ur.created_at < $3
         GROUP BY ur.model`,
        [userId, periodStart, periodEnd],
      )

      // Create invoice first (we'll update total_due later)
      const invoiceRes = await client.query(
        `INSERT INTO invoices (user_id, period_start, period_end, status, due_date, issued_at, discount_rate)
         VALUES ($1, $2, $3, 'issued', $4, now(), $5)
         RETURNING id`,
        [userId, periodStart, periodEnd, dueDate, discountRate],
      )
      const invoiceId: string = invoiceRes.rows[0].id

      let tokenCostTotal = 0

      // 2b-c. For each model, look up pricing and create invoice_items
      for (const row of usageByModel.rows) {
        const modelName: string = row.model
        const inputTokens = BigInt(row.input_tokens)
        const outputTokens = BigInt(row.output_tokens)
        const cacheRead = BigInt(row.cache_read)
        const cacheWrite = BigInt(row.cache_write)

        // Find latest pricing effective before period_end
        const pricingRes = await client.query(
          `SELECT input_mtok, output_mtok, cache_read_mtok, cache_write_mtok
           FROM model_pricing
           WHERE model_pattern = $1 AND effective_from <= $2
           ORDER BY effective_from DESC
           LIMIT 1`,
          [modelName, periodEnd],
        )

        // If no exact match, try prefix match
        let pricing = pricingRes.rows[0]
        if (!pricing) {
          const fuzzyRes = await client.query(
            `SELECT input_mtok, output_mtok, cache_read_mtok, cache_write_mtok
             FROM model_pricing
             WHERE $1 LIKE model_pattern || '%' AND effective_from <= $2
             ORDER BY effective_from DESC
             LIMIT 1`,
            [modelName, periodEnd],
          )
          pricing = fuzzyRes.rows[0]
        }

        if (!pricing) continue // skip models without pricing

        // Cost = tokens / 1_000_000 * price_per_mtok
        const cost =
          (Number(inputTokens) / 1_000_000) * Number(pricing.input_mtok) +
          (Number(outputTokens) / 1_000_000) * Number(pricing.output_mtok) +
          (Number(cacheRead) / 1_000_000) * Number(pricing.cache_read_mtok) +
          (Number(cacheWrite) / 1_000_000) * Number(pricing.cache_write_mtok)

        tokenCostTotal += cost

        await client.query(
          `INSERT INTO invoice_items (invoice_id, type, model, input_tokens, output_tokens, unit_cost, subtotal)
           VALUES ($1, 'token', $2, $3, $4, $5, $6)`,
          [
            invoiceId,
            modelName,
            Number(inputTokens),
            Number(outputTokens),
            cost / ((Number(inputTokens) + Number(outputTokens)) || 1) * 1_000_000,
            cost,
          ],
        )
      }

      // 2d-e. Cost share based on daily_costs
      let shareCost = 0
      if (totalDailyCost > 0 && allTokensTotal > 0n) {
        // User's total tokens
        const userTokensRes = await client.query(
          `SELECT COALESCE(SUM(input_tokens::bigint + output_tokens::bigint + cache_read::bigint + cache_write::bigint), 0) AS total
           FROM usage_records ur
           JOIN clients c ON c.id = ur.client_id AND c.user_id = $1
           WHERE ur.created_at >= $2 AND ur.created_at < $3`,
          [userId, periodStart, periodEnd],
        )
        const userTokens = BigInt(userTokensRes.rows[0].total)

        if (userTokens > 0n) {
          const shareRatio = Number(userTokens) / Number(allTokensTotal)
          shareCost = shareRatio * totalDailyCost

          await client.query(
            `INSERT INTO invoice_items (invoice_id, type, total_cost, user_tokens, all_tokens, share_ratio)
             VALUES ($1, 'share', $2, $3, $4, $5)`,
            [invoiceId, shareCost, Number(userTokens), Number(allTokensTotal), shareRatio],
          )
        }
      }

      // 2f. Original amount before discount
      const originalAmount = tokenCostTotal + shareCost

      // Check free_until — if entire period is within free window, zero out
      let effectiveDiscount = discountRate
      if (freeUntil && freeUntil >= periodEnd) {
        effectiveDiscount = 0
      }

      let afterDiscount = originalAmount * effectiveDiscount

      // 2g. Check active rewards (token_credit, free_days)
      let tokenCreditUsed = 0n
      const rewardsRes = await client.query(
        `SELECT id, type, token_remaining, free_until AS reward_free_until, discount_rate AS reward_discount
         FROM rewards
         WHERE user_id = $1 AND status = 'active'
           AND (expires_at IS NULL OR expires_at > now())
         ORDER BY created_at`,
        [userId],
      )

      for (const reward of rewardsRes.rows) {
        if (reward.type === 'free_days' && reward.reward_free_until) {
          const rewardFreeUntil = new Date(reward.reward_free_until)
          if (rewardFreeUntil >= periodEnd) {
            afterDiscount = 0
          }
        } else if (reward.type === 'token_credit' && reward.token_remaining > 0) {
          // Convert remaining token credits to dollar value (rough: use average cost per token)
          // Simpler approach: deduct from the monetary total directly
          // token_remaining is a token count; we'll convert by average token price
          const remaining = BigInt(reward.token_remaining)
          const avgCostPerToken = originalAmount > 0
            ? originalAmount / Number(allTokensTotal || 1n)
            : 0
          const creditValue = Number(remaining) * avgCostPerToken
          const deduction = Math.min(creditValue, afterDiscount)
          afterDiscount -= deduction

          // Calculate tokens actually used
          const tokensUsed = avgCostPerToken > 0
            ? BigInt(Math.floor(deduction / avgCostPerToken))
            : 0n
          tokenCreditUsed += tokensUsed

          // Update reward
          const newRemaining = remaining - tokensUsed
          await client.query(
            `UPDATE rewards SET token_remaining = $1, status = CASE WHEN $1 <= 0 THEN 'used' ELSE status END
             WHERE id = $2`,
            [Number(newRemaining), reward.id],
          )
        }
      }

      const totalDue = Math.max(0, Math.round(afterDiscount * 100) / 100)

      // 2h. Update invoice with final amounts
      await client.query(
        `UPDATE invoices
         SET original_amount = $1, total_due = $2, token_credit_used = $3
         WHERE id = $4`,
        [Math.round(originalAmount * 100) / 100, totalDue, Number(tokenCreditUsed), invoiceId],
      )

      await client.query('COMMIT')
      invoiceCount++
    } catch (err) {
      await client.query('ROLLBACK')
      console.error(`Failed to generate invoice for user ${user.user_id}:`, err)
    } finally {
      client.release()
    }
  }

  return invoiceCount
}
