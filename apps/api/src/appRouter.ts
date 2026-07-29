import { router } from './trpc/router'
import { healthQuery } from './routers/health'
import { assignmentRouter } from './routers/assignment'
import { repRouter } from './routers/rep'
import { adminRouter } from './routers/admin'
import { authRouter } from './routers/auth'
import { boardRouter } from './routers/board'
import { userManagementRouter } from './routers/userManagement'

export const appRouter = router({
  health: healthQuery,
  assignment: assignmentRouter,
  rep: repRouter,
  admin: adminRouter,
  auth: authRouter,
  board: boardRouter,
  userManagement: userManagementRouter,
})

export type AppRouter = typeof appRouter
