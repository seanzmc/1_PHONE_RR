import { router } from './trpc/router'
import { healthQuery } from './routers/health'

export const appRouter = router({
  health: healthQuery,
})

export type AppRouter = typeof appRouter
