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

export const createAccountInputSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  role: z.enum(['ADMIN', 'MANAGER', 'BDC', 'REP']),
  password: z.string().min(8),
})

export const setRoleInputSchema = z.object({
  userId: z.string().uuid(),
  newRole: z.enum(['ADMIN', 'MANAGER', 'BDC', 'REP']),
})

export const setActiveInputSchema = z.object({
  userId: z.string().uuid(),
  isActive: z.boolean(),
})

export const resetPasswordInputSchema = z.object({
  userId: z.string().uuid(),
  newPassword: z.string().min(8),
})

/* ── activity (design pass §H, §J) ───────────────────────────────────────── */

export const activityImportInputSchema = z.object({
  csv: z.string().min(1),
  /**
   * The business date the report covers — normally the PRIOR day, since the export is
   * yesterday's activity imported this morning. Always explicit; never inferred from now().
   */
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

export const setMetricInputSchema = z
  .object({
    repId: z.string().uuid(),
    businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    calls: z.number().int().min(0).optional(),
    sold: z.number().int().min(0).optional(),
    reasonNote: z.string().min(1),
  })
  .refine((v) => v.calls !== undefined || v.sold !== undefined, {
    message: 'provide calls, sold, or both',
  })

/* ── lead notes (design pass §D) ─────────────────────────────────────────── */

export const setLeadNoteInputSchema = z.object({
  leadId: z.string().uuid(),
  note: z.string().max(2000),
})

/* ── recurring days off (design pass §I) ─────────────────────────────────── */

export const setDaysOffInputSchema = z.object({
  repId: z.string().uuid(),
  // 0=Sunday..6=Saturday; Sunday is store-closed and ignored server-side.
  daysOfWeek: z.array(z.number().int().min(0).max(6)),
})

export type AssignLeadInput = z.infer<typeof assignLeadInputSchema>
export type VoidLeadInput = z.infer<typeof voidLeadInputSchema>
export type StatusOverrideInput = z.infer<typeof statusOverrideInputSchema>
export type CreateAccountInput = z.infer<typeof createAccountInputSchema>
export type SetRoleInput = z.infer<typeof setRoleInputSchema>
export type SetActiveInput = z.infer<typeof setActiveInputSchema>
export type ResetPasswordInput = z.infer<typeof resetPasswordInputSchema>
export type ActivityImportInput = z.infer<typeof activityImportInputSchema>
export type SetMetricInput = z.infer<typeof setMetricInputSchema>
export type SetLeadNoteInput = z.infer<typeof setLeadNoteInputSchema>
export type SetDaysOffInput = z.infer<typeof setDaysOffInputSchema>
