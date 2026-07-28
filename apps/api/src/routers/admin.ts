import { z } from 'zod'
import { db } from '@phoneup/db'
import { publicProcedure, router } from '../trpc/router'
import { requirePerm } from '../trpc/requirePerm'
import { parseCrmImport } from '../jobs/crmImport'

const crmImportInputSchema = z.object({
  csv: z.string().min(1),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

export const adminRouter = router({
  crmImport: publicProcedure
    .use(requirePerm('schedule.manage'))
    .input(crmImportInputSchema)
    .mutation(async ({ input }) => {
      return parseCrmImport(db, input.csv, input.businessDate)
    }),
})
