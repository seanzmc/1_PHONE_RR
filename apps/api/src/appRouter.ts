import { router } from './trpc/router'
import { healthQuery } from './routers/health'
import { assignmentRouter } from './routers/assignment'
import { repRouter } from './routers/rep'
import { adminRouter } from './routers/admin'

export const appRouter = router({
  health: healthQuery,
  assignment: assignmentRouter,
  rep: repRouter,
  admin: adminRouter,
})

export type AppRouter = typeof appRouter
