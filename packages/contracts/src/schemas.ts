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

export type AssignLeadInput = z.infer<typeof assignLeadInputSchema>
export type VoidLeadInput = z.infer<typeof voidLeadInputSchema>
export type StatusOverrideInput = z.infer<typeof statusOverrideInputSchema>
export type CreateAccountInput = z.infer<typeof createAccountInputSchema>
export type SetRoleInput = z.infer<typeof setRoleInputSchema>
export type SetActiveInput = z.infer<typeof setActiveInputSchema>
export type ResetPasswordInput = z.infer<typeof resetPasswordInputSchema>
