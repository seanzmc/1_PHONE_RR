import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { db, schema } from './client'

function parseRoster(tsv: string): Array<{ name: string; email: string }> {
  const lines = tsv.split('\n').filter((line) => line.trim().length > 0)
  const [, ...rows] = lines // skip header

  return rows.map((line, i) => {
    const [name, email] = line.split('\t')
    if (!name || !email) {
      throw new Error(`Row ${i + 2}: expected "Name\\tEmail\\tRole", got: ${JSON.stringify(line)}`)
    }
    return { name, email }
  })
}

async function backfill() {
  const tsvPath = resolve(process.cwd(), process.argv[2] ?? './Name Email Role.tsv')
  const tsv = readFileSync(tsvPath, 'utf-8')
  const rows = parseRoster(tsv)

  let updated = 0
  for (const row of rows) {
    const result = await db
      .update(schema.appUser)
      .set({ displayName: row.name })
      .where(eq(schema.appUser.email, row.email))
      .returning()
    if (result.length > 0) updated++
  }

  console.log(`Backfilled display_name for ${updated}/${rows.length} accounts.`)
  process.exit(0)
}

backfill().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
