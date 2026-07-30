import { router } from './trpc/router'
import { healthQuery } from './routers/health'
import { assignmentRouter } from './routers/assignment'
import { repRouter } from './routers/rep'
import { adminRouter } from './routers/admin'
import { authRouter } from './routers/auth'
import { boardRouter } from './routers/board'
import { userManagementRouter } from './routers/userManagement'
import { leadRouter } from './routers/lead'
import { activityRouter } from './routers/activity'

export const appRouter = router({
  health: healthQuery,
  assignment: assignmentRouter,
  rep: repRouter,
  admin: adminRouter,
  auth: authRouter,
  board: boardRouter,
  userManagement: userManagementRouter,
  lead: leadRouter,
  activity: activityRouter,
})

export type AppRouter = typeof appRouter
