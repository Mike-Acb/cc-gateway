import pg from 'pg'
import bcrypt from 'bcryptjs'

const client = new pg.Client({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME ?? 'cc_gateway',
  user: process.env.DB_USER ?? 'cc_gateway',
  password: process.env.DB_PASSWORD ?? 'change-me-password',
})

const username = process.argv[2] || 'admin'
const email = process.argv[3] || 'admin@example.com'
const password = process.argv[4] || 'admin123'

async function main() {
  await client.connect()
  const hash = await bcrypt.hash(password, 12)
  const result = await client.query(
    `INSERT INTO users (username, email, password_hash, role, status)
     VALUES ($1, $2, $3, 'admin', 'active')
     ON CONFLICT (email) DO UPDATE SET password_hash = $3, role = 'admin'
     RETURNING id, username, email, role`,
    [username, email, hash],
  )
  console.log('Admin created:', result.rows[0])
  await client.end()
}

main().catch(err => {
  console.error('Failed:', err.message)
  process.exit(1)
})
