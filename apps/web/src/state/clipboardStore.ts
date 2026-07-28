import { create } from 'zustand'

type ClipboardState = {
  lastCopiedPhone: string | null
  setLastCopiedPhone: (digits: string) => void
}

export const useClipboardStore = create<ClipboardState>((set) => ({
  lastCopiedPhone: null,
  setLastCopiedPhone: (digits) => set({ lastCopiedPhone: digits }),
}))

export function digitsOnly(phoneE164: string): string {
  return phoneE164.replace(/^\+1/, '').replace(/\D/g, '')
}
