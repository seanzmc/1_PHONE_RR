import { z } from 'zod'

export const assignLeadInputSchema = z.object({
  idempotencyKey: z.string().uuid(),
  customerName: z.string().min(1),
  customerPhoneE164: z.string().regex(/^\+1\d{10}$/),
  notes: z.string().optional(),
  forcedRepId: z.string().uuid().optional(),
})

export const voidLeadInputSchema = z.object({
  leadId: z.string().uuid(),
  reasonNote: z.string().min(1),
})

export const statusOverrideInputSchema = z.object({
  repId: z.string().uuid(),
  status: z.enum(['FORCE_ACTIVE', 'FORCE_INACTIVE', 'FOLLOW_SCHEDULE']),
  reasonCode: z.string().min(1),
  reasonNote: z.string().min(1),
})

export type AssignLeadInput = z.infer<typeof assignLeadInputSchema>
export type VoidLeadInput = z.infer<typeof voidLeadInputSchema>
export type StatusOverrideInput = z.infer<typeof statusOverrideInputSchema>
