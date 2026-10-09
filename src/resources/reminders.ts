import type { RequestFn } from '../types'

export type ScheduleReminder = {
  readonly body: string
  readonly title?: string
  readonly agentName?: string
  readonly sessionId?: string
  readonly machineId?: string
  readonly env?: 'test'
} & ({ readonly inMinutes: number; readonly at?: never } | { readonly at: string; readonly inMinutes?: never })

export interface Reminder {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly fireAt: string
  readonly status: 'scheduled' | 'firing' | 'dispatched' | 'cancelled' | 'suppressed' | 'failed'
}

export interface ReminderResult {
  readonly reminder?: Reminder
  readonly duplicate?: boolean
  readonly cancelled?: boolean
  readonly pending: readonly Reminder[]
  readonly hint: string
  readonly warning?: string
}

export interface RemindersResource {
  readonly schedule: (input: ScheduleReminder) => Promise<ReminderResult>
  readonly list: () => Promise<ReminderResult>
  readonly cancel: (id: string) => Promise<ReminderResult>
}

export const createRemindersResource = (request: RequestFn): RemindersResource => Object.freeze({
  schedule: (input: ScheduleReminder) => request<ReminderResult>('POST', '/reminders', input),
  list: () => request<ReminderResult>('GET', '/reminders'),
  cancel: (id: string) => request<ReminderResult>('POST', '/reminders', { cancelReminderId: id }),
})
