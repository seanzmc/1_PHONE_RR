import { publicProcedure } from '../trpc/router'

export const healthQuery = publicProcedure.query(() => ({ ok: true }))
