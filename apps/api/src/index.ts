import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import { appRouter } from './appRouter'
import { createContext } from './trpc/context'
import { attachRealtimeServer } from './realtime/server'

const server = Fastify({ logger: true })

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
})
