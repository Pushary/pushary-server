import type { RequestFn, SendNotification, SendResult } from '../types'

export interface NotificationsResource {
  readonly send: (data: SendNotification) => Promise<SendResult>
}

export const createNotificationsResource = (request: RequestFn): NotificationsResource =>
  Object.freeze({
    send: (data: SendNotification) =>
      request<SendResult>('POST', '/send', data),
  })

