import app from './app.js'
import { startInvoiceGenerator } from './jobs/invoice-generator.js'
import { startOverdueChecker } from './jobs/overdue-checker.js'

const PORT = Number(process.env.PORT ?? 3000)

app.listen(PORT, () => {
  console.log(`2Coding Gateway API Server listening on port ${PORT}`)
  startInvoiceGenerator()
  startOverdueChecker()
})
