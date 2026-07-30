import { randomInt } from 'node:crypto'

/**
 * Short, human-speakable temporary passwords.
 *
 * Kept short deliberately (a manager reads it down the phone) and made safe by three
 * things together, not by length alone:
 *   1. single-use — the holder is flagged mustChangePassword, so the server refuses
 *      every route except changePassword until it is replaced;
 *   2. login throttling (see apps/api/src/auth/loginThrottle.ts) — online guessing is
 *      rate-limited per email and per IP, so the small keyspace can't be swept;
 *   3. no ambiguous characters (0/O, 1/l/I), so it is read back correctly first time.
 *
 * Shape: word-word-NNN  e.g. "brisk-otter-472"  (~20 bits over 4 wordlists)
 *
 * Lives in core so the API routes, the roster importer and the dev seed all issue the
 * same shape from one implementation — a second copy is how a shared default sneaks back in.
 */

/** Digits that can't be misheard or misread: no 0 (vs O) and no 1 (vs l/I). */
const SAFE_DIGITS = '23456789'

const ADJECTIVES = [
  'brisk', 'calm', 'clever', 'crisp', 'eager', 'fair', 'fast', 'firm',
  'fresh', 'glad', 'keen', 'kind', 'lucky', 'neat', 'proud', 'quick',
  'ready', 'sharp', 'smart', 'solid', 'spare', 'stark', 'sunny', 'swift',
  'tidy', 'tough', 'true', 'warm', 'wise', 'zesty', 'bright', 'bold',
  'steady', 'humble', 'nimble', 'rugged', 'candid', 'earnest',
]

const NOUNS = [
  'anchor', 'arrow', 'badger', 'beacon', 'canyon', 'cedar', 'comet', 'copper',
  'dagger', 'delta', 'ember', 'falcon', 'garnet', 'harbor', 'hunter', 'jasper',
  'kettle', 'lantern', 'marble', 'meadow', 'nickel', 'otter', 'pepper', 'quartz',
  'ranger', 'ribbon', 'saddle', 'timber', 'walnut', 'willow', 'cobalt', 'granite',
  'juniper', 'compass', 'foundry', 'skyline', 'thicket', 'vessel',
]

export function generateTempPassword(): string {
  const adj = ADJECTIVES[randomInt(ADJECTIVES.length)]
  const noun = NOUNS[randomInt(NOUNS.length)]
  let digits = ''
  for (let i = 0; i < 3; i++) digits += SAFE_DIGITS[randomInt(SAFE_DIGITS.length)]
  return `${adj}-${noun}-${digits}`
}
