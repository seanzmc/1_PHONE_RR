import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import { db } from '@phoneup/db'
import { appRouter } from './appRouter'
import { createContext } from './trpc/context'
import { attachRealtimeServer } from './realtime/server'
import { scheduleEligibilityJob } from './jobs/eligibility'
import { scheduleReconciliationJob } from './jobs/reconciliation'

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

const port = Number(process.env.PORT ?? 3000)

server.listen({ port }, (err) => {
  if (err) {
    server.log.error(err)
    process.exit(1)
  }
  attachRealtimeServer(server.server)
  scheduleEligibilityJob(db)
  scheduleReconciliationJob(db)
})
