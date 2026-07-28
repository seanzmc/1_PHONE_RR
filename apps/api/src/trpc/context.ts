import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import { loadSession } from '../auth/session'
import type { Role } from '@phoneup/contracts'

export type Context = {
  session: { userId: string; role: Role } | null
  req: CreateFastifyContextOptions['req']
  res: CreateFastifyContextOptions['res']
}

export async function createContext({ req, res }: CreateFastifyContextOptions): Promise<Context> {
  const sid = (req as any).cookies?.sid as string | undefined
  const session = sid ? await loadSession(sid) : null
  return { session, req, res }
}
