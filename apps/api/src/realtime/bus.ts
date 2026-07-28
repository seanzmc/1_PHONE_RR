import { EventEmitter } from 'node:events'

export const bus = new EventEmitter()

export function publishAssignment(payload: unknown): void {
  bus.emit('assignment', payload)
}
