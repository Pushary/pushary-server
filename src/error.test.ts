import { describe, it, expect } from 'vitest'
import { PusharyApiError } from './error'

describe('PusharyApiError', () => {
  // The whole point of extending Error: every consumer already shipped against
  // a plain Error, and a published SDK cannot break those on a patch bump.
  it('is still an Error, so existing catch blocks keep working', () => {
    const err = new PusharyApiError('Invalid or missing API key', { status: 401 })
    expect(err instanceof Error).toBeTruthy()
    expect(err instanceof PusharyApiError).toBeTruthy()
    expect(err.message).toBe('Invalid or missing API key')
    expect(err.name).toBe('PusharyApiError')
    expect(err.stack).toBeTruthy()
  })

  it('carries the status a caller previously had to string-match for', () => {
    const err = new PusharyApiError('nope', { status: 429, statusText: 'Too Many Requests' })
    expect(err.status).toBe(429)
    expect(err.statusText).toBe('Too Many Requests')
  })

  it('classifies the three failures that need different handling', () => {
    const auth = new PusharyApiError('bad key', { status: 401 })
    expect(auth.isAuthError).toBe(true)
    expect(auth.isRateLimited).toBe(false)
    expect(auth.isServerError).toBe(false)

    // 403 is an auth failure too: a revoked key and a plan limit both mean
    // "stop and fix the credential", not "retry".
    expect(new PusharyApiError('forbidden', { status: 403 }).isAuthError).toBe(true)

    const limited = new PusharyApiError('slow down', { status: 429 })
    expect(limited.isRateLimited).toBe(true)
    expect(limited.isAuthError).toBe(false)

    const down = new PusharyApiError('boom', { status: 503 })
    expect(down.isServerError).toBe(true)
    expect(down.isAuthError).toBe(false)

    // A 400 is the caller's own fault and is none of the three.
    const bad = new PusharyApiError('bad argument', { status: 400 })
    expect(bad.isAuthError).toBe(false)
    expect(bad.isRateLimited).toBe(false)
    expect(bad.isServerError).toBe(false)
  })

  it('keeps the API code and raw body for anything the getters do not cover', () => {
    const err = new PusharyApiError('nope', {
      status: 422,
      code: 'subscriber_not_found',
      body: { error: 'nope', code: 'subscriber_not_found', hint: 'check the id' },
    })
    expect(err.code).toBe('subscriber_not_found')
    expect(err.body).toEqual({ error: 'nope', code: 'subscriber_not_found', hint: 'check the id' })
  })

  it('defaults statusText and leaves code undefined when the API sent neither', () => {
    const err = new PusharyApiError('HTTP 500', { status: 500 })
    expect(err.statusText).toBe('')
    expect(err.code).toBe(undefined)
    expect(err.body).toBe(undefined)
  })
})
