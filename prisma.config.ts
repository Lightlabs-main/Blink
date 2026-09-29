import { defineConfig } from 'prisma/config'

// Load Blink's own .env only (never another project's). Node >= 20.12 provides process.loadEnvFile.
try {
  process.loadEnvFile('.env')
} catch {
  // No .env present: rely on the process environment.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'] ?? '',
  },
})
