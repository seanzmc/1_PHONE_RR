import { and, eq } from 'drizzle-orm'
import { schema } from '@phoneup/db'

/**
 * Membership filter for every operational rep surface. Rotation eligibility still comes
 * exclusively from rep_daily_status; account enablement only decides whether a person is
 * part of the live roster at all.
 */
export async function selectActiveReps(executor: any): Promise<any[]> {
  const rows = await executor
    .select({ rep: schema.salesRep })
    .from(schema.salesRep)
    .innerJoin(schema.appUser, eq(schema.appUser.id, schema.salesRep.userId))
    .where(eq(schema.appUser.isActive, true))
  return rows.map(({ rep }: any) => rep)
}

export async function isActiveRep(executor: any, repId: string): Promise<boolean> {
  const rows = await executor
    .select({ id: schema.salesRep.id })
    .from(schema.salesRep)
    .innerJoin(schema.appUser, eq(schema.appUser.id, schema.salesRep.userId))
    .where(and(eq(schema.salesRep.id, repId), eq(schema.appUser.isActive, true)))
    .limit(1)
  return rows.length === 1
}
