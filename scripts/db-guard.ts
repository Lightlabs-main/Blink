/**
 * Refuses to continue unless DATABASE_URL targets Blink's own database (MASTER_PROMPT VPS isolation).
 * Prints the target database name, then exits non-zero on any doubt. Used before every migration.
 */
export function assertBlinkDatabase(databaseUrl: string | undefined, expectedName: string): string {
  if (!databaseUrl) throw new Error('DATABASE_URL is not set')
  let url: URL
  try {
    url = new URL(databaseUrl)
  } catch {
    throw new Error('DATABASE_URL is not a valid URL')
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error(`DATABASE_URL protocol ${url.protocol} is not PostgreSQL`)
  }
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!name) throw new Error('DATABASE_URL has no database name')
  if (name !== expectedName) {
    throw new Error(`Refusing: DATABASE_URL targets "${name}", expected "${expectedName}"`)
  }
  return name
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/db-guard.ts')
if (isMain) {
  try {
    process.loadEnvFile('.env')
  } catch {
    // rely on process env
  }
  const expected = process.env.BLINK_DATABASE_NAME ?? 'blink_to_stock'
  try {
    const name = assertBlinkDatabase(process.env.DATABASE_URL, expected)
    console.log(`Target database: ${name} (matches BLINK_DATABASE_NAME)`)
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }
}
