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

export const bulkStatusOverrideInputSchema = z.object({
  // Capped well above a single store's roster (~30 reps). The cap is a guard against a
  // malformed client, not a product limit.
  repIds: z
    .array(z.string().uuid())
    .min(1)
    .max(200)
    .transform((ids) => [...new Set(ids)]),
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

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
  }, 'invalid calendar date')

const postgresNonNegativeIntegerSchema = z.number().int().min(0).max(2_147_483_647)

export const activityImportPreviewInputSchema = z.object({
  csv: z.string().min(1).max(5_000_000),
  /**
   * The business date the report covers — normally the PRIOR day, since the export is
   * yesterday's activity imported this morning. Always explicit; never inferred from now().
   */
  businessDate: isoDateSchema,
})

/** Backward-compatible name used by the CLI/direct import path. */
export const activityImportInputSchema = activityImportPreviewInputSchema

export const activityImportCommitInputSchema = activityImportPreviewInputSchema.extend({
  /** Status/rotation date shown in the preview. Server rejects a stale day. */
  statusDate: isoDateSchema,
  /** One-time nonce + HMAC-SHA-256 authentication tag returned by preview. */
  previewToken: z.string().length(128).regex(/^[a-f0-9]{128}$/),
  decision: z.enum(['LOG_ONLY', 'LOG_AND_DEACTIVATE']),
})

export const setMetricInputSchema = z
  .object({
    repId: z.string().uuid(),
    businessDate: isoDateSchema,
    calls: postgresNonNegativeIntegerSchema.optional(),
    sold: postgresNonNegativeIntegerSchema.optional(),
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
export type BulkStatusOverrideInput = z.infer<typeof bulkStatusOverrideInputSchema>
export type CreateAccountInput = z.infer<typeof createAccountInputSchema>
export type SetRoleInput = z.infer<typeof setRoleInputSchema>
export type SetActiveInput = z.infer<typeof setActiveInputSchema>
export type ResetPasswordInput = z.infer<typeof resetPasswordInputSchema>
export type ActivityImportInput = z.infer<typeof activityImportInputSchema>
export type ActivityImportPreviewInput = z.infer<typeof activityImportPreviewInputSchema>
export type ActivityImportCommitInput = z.infer<typeof activityImportCommitInputSchema>
export type SetMetricInput = z.infer<typeof setMetricInputSchema>
export type SetLeadNoteInput = z.infer<typeof setLeadNoteInputSchema>
export type SetDaysOffInput = z.infer<typeof setDaysOffInputSchema>
