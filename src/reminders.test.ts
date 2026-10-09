import { afterEach, expect, it, vi } from 'vitest'
import { createPusharyServer } from './client'

afterEach(() => vi.unstubAllGlobals())
it('schedules, lists and cancels personal reminders over the authenticated server resource', async () => {
  const fetch = vi.fn(async () => Response.json({ pending: [], hint: 'saved' }))
  vi.stubGlobal('fetch', fetch)
  const client = createPusharyServer({ apiKey: 'pk_test.secret' })
  await client.reminders.schedule({ body: 'Check deploy', inMinutes: 30, requestId: 'stable-request' })
  await client.reminders.list()
  await client.reminders.cancel('reminder-id')
  await client.reminders.get('reminder-id')
  expect(fetch.mock.calls).toHaveLength(4)
  expect(fetch).toHaveBeenNthCalledWith(1, 'https://pushary.com/api/v1/server/reminders', expect.objectContaining({ method: 'POST', body: JSON.stringify({ body: 'Check deploy', inMinutes: 30, requestId: 'stable-request' }) }))
  expect(fetch).toHaveBeenNthCalledWith(2, 'https://pushary.com/api/v1/server/reminders', expect.objectContaining({ method: 'GET' }))
  expect(fetch).toHaveBeenNthCalledWith(3, 'https://pushary.com/api/v1/server/reminders', expect.objectContaining({ method: 'POST', body: JSON.stringify({ cancelReminderId: 'reminder-id' }) }))
  expect(fetch).toHaveBeenNthCalledWith(4, 'https://pushary.com/api/v1/server/reminders', expect.objectContaining({ method: 'POST', body: JSON.stringify({ reminderId: 'reminder-id' }) }))
})
