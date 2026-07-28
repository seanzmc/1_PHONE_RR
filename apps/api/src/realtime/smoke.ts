import { WebSocket } from 'ws'
import { publishAssignment } from './bus'

const socket = new WebSocket('ws://localhost:3099/ws/board')

socket.on('open', () => {
  console.log('connected')
  publishAssignment({ leadId: 'test-lead', assignedRepId: 'test-rep' })
})

socket.on('message', (data) => {
  console.log('received:', data.toString())
  process.exit(0)
})

setTimeout(() => {
  console.log('timed out, no message received')
  process.exit(1)
}, 3000)
