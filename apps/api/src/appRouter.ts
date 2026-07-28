import { router } from './trpc/router'
import { healthQuery } from './routers/health'
import { assignmentRouter } from './routers/assignment'

export const appRouter = router({
  health: healthQuery,
  assignment: assignmentRouter,
})

export type AppRouter = typeof appRouter
