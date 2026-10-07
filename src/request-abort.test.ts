import { afterEach, expect, it, vi } from 'vitest'
import { createPusharyServer } from './client'
const client = (timeout = 100) => createPusharyServer({ apiKey: 'pk_test.secret', baseUrl: 'https://invalid.test', requestTimeoutMs: timeout })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
it('does not fetch for a pre-aborted decision create', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  const reason = new Error('owner stopped')
  await expect(client().decisions.create({ question: 'Go?' }, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
  expect(fetch).not.toHaveBeenCalled()
})
it.each(['create', 'get', 'cancel'])('cancels %s with the original owner reason', async operation => {
  const controller = new AbortController()
  vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))))
  const decisions = client().decisions
  const pending = operation === 'create' ? decisions.create({ question: 'Go?' }, { signal: controller.signal }) : operation === 'get' ? decisions.get('d1', { wait: 5, signal: controller.signal }) : decisions.cancel('d1', { signal: controller.signal })
  const reason = new Error('cancel'); controller.abort(reason)
  await expect(pending).rejects.toBe(reason)
})
it('keeps the HTTP deadline when an owner signal is supplied, through body reading', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => ({ ok: true, json: () => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))) })))
  const pending = client(10).decisions.get('d1', { signal: new AbortController().signal })
  const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
  await vi.advanceTimersByTimeAsync(11); await assertion
})
it('preserves original signatures and excludes signal from GET query', async () => {
  const fetch = vi.fn(async (_url: string) => Response.json({})); vi.stubGlobal('fetch', fetch)
  await client().decisions.create({ question: 'Go?' }); await client().decisions.get('d1', { wait: 5, signal: new AbortController().signal }); await client().decisions.cancel('d1')
  expect(String(fetch.mock.calls[1]?.[0])).toBe('https://invalid.test/decisions/d1?wait=5')
})
it.each([400, 503])('preserves owner cancellation while reading an HTTP %i body', async status => {
  const controller = new AbortController()
  const reason = new Error('owner stopped during error response')
  let bodyStarted: () => void = () => undefined
  const readingBody = new Promise<void>(resolve => { bodyStarted = resolve })
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => ({
    ok: false,
    status,
    statusText: 'Failure',
    json: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason))
      bodyStarted()
    }),
  })))
  const pending = client().decisions.get('d1', { signal: controller.signal })
  const assertion = expect(pending).rejects.toBe(reason)
  await readingBody
  controller.abort(reason)
  await assertion
})
it.each([400, 503])('preserves HTTP timeout while reading an HTTP %i body', async status => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => ({
    ok: false,
    status,
    statusText: 'Failure',
    json: () => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))),
  })))
  const pending = client(10).decisions.get('d1')
  const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
  await vi.advanceTimersByTimeAsync(11)
  await assertion
})
it.each([200, 503])('preserves owner cancellation when an HTTP %i body completes concurrently', async status => {
  const controller = new AbortController()
  const reason = new Error('owner stopped as body completed')
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status === 200,
    status,
    statusText: 'Response',
    json: async () => {
      controller.abort(reason)
      return { decisionId: 'd1' }
    },
  })))
  await expect(client().decisions.get('d1', { signal: controller.signal })).rejects.toBe(reason)
})
