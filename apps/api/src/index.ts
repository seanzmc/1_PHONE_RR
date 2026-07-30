import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import staticPlugin from '@fastify/static'
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import { db } from '@phoneup/db'
import { appRouter } from './appRouter'
import { checkDatabase } from './routers/health'
import { createContext } from './trpc/context'
import { attachRealtimeServer } from './realtime/server'
import { scheduleEligibilityJob, scheduleShiftMaterializationJob } from './jobs/eligibility'
import { scheduleReconciliationJob } from './jobs/reconciliation'

const __dirname = dirname(fileURLToPath(import.meta.url))

const server = Fastify({ logger: true })

await server.register(cors, {
  origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  credentials: true,
})
await server.register(cookie)

await server.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: { router: appRouter, createContext },
})

// The platform healthcheck (railway.json) hits this. It must fail when the database is
// unreachable, otherwise a deploy with a bad DATABASE_URL goes green and stays up.
server.get('/health', async (_req, reply) => {
  if (await checkDatabase()) return { ok: true }
  server.log.error('health check failed: database unreachable')
  return reply.code(503).send({ ok: false, error: 'database unreachable' })
})

// Same-origin static hosting of the built web app, when present, so browser
// requests to the API and the app share one origin — avoids cross-site
// cookie config entirely. Absent in local dev (web runs on its own Vite server).
const webDist = join(__dirname, '../../web/dist')
if (existsSync(webDist)) {
  await server.register(staticPlugin, { root: webDist })
}

const port = Number(process.env.PORT ?? 3000)

server.listen({ port, host: '0.0.0.0' }, (err) => {
  if (err) {
    server.log.error(err)
    process.exit(1)
  }
  attachRealtimeServer(server.server)
  scheduleEligibilityJob(db)
  scheduleReconciliationJob(db)
  scheduleShiftMaterializationJob(db)
})
