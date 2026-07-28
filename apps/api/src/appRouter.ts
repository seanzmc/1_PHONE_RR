import { router } from './trpc/router'
import { healthQuery } from './routers/health'
import { assignmentRouter } from './routers/assignment'
import { repRouter } from './routers/rep'

export const appRouter = router({
  health: healthQuery,
  assignment: assignmentRouter,
  rep: repRouter,
})

export type AppRouter = typeof appRouter
