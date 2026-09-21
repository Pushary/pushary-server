import { describe, it, expect, afterEach } from 'vitest'
import {
  createPusharyServer,
  deterministicKey,
  isApproved,
  parseDecisionCallback,
  SIGNATURE_HEADER,
} from './index'

interface Recorded {
  readonly url: string
  readonly method: string
  readonly body: Record<string, unknown> | undefined
}

type Responder = (call: Recorded) => { status?: number; json: unknown }

const realFetch = globalThis.fetch

const installFetch = (responders: readonly Responder[]): Recorded[] => {
  const calls: Recorded[] = []
  let i = 0
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const call: Recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    }
    calls.push(call)
    const responder = responders[Math.min(i, responders.length - 1)]
    i += 1
    const { status = 200, json } = responder(call)
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
    } as Response
  }) as typeof fetch
  return calls
}

afterEach(() => {
  globalThis.fetch = realFetch
})

const px = () => createPusharyServer({ apiKey: 'pk_test.sk_test' })

describe('enroll', () => {
  it('POSTs externalId to /api/v1/server/enroll and returns the connect link', async () => {
    const calls = installFetch([
      () => ({
        json: {
          externalId: 'user_1',
          token: 'tok',
          deepLink: 'pushary://enroll?token=tok',
          universalLink: 'https://pushary.com/e/tok',
          expiresInSeconds: 900,
        },
      }),
    ])
    const result = await px().enroll('user_1')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('https://pushary.com/api/v1/server/enroll')
    expect(calls[0].body).toEqual({ externalId: 'user_1' })
    expect(result.universalLink).toBe('https://pushary.com/e/tok')
  })
})

describe('decisions.ask', () => {
  it('creates async then long-polls the correct prefixed URL until answered (approved)', async () => {
    const calls = installFetch([
      () => ({ json: { decisionId: 'd1', status: 'pending', answered: false, type: 'confirm' } }),
      () => ({
        json: {
          decisionId: 'd1',
          status: 'answered',
          answered: true,
          value: 'yes',
          type: 'confirm',
          question: 'Ship it?',
          options: null,
          externalId: 'user_1',
          createdAt: '',
          answeredAt: '',
          expiresAt: '',
        },
      }),
    ])
    const r = await px().decisions.ask({ question: 'Ship it?', externalId: 'user_1', timeoutMs: 5000 })

    const [create, poll] = calls
    expect(create.method).toBe('POST')
    expect(create.url).toBe('https://pushary.com/api/v1/server/decisions')
    expect(create.body?.wait).toBe(false)
    expect(create.body?.externalId).toBe('user_1')
    expect(create.body?.idempotencyKey).toBeTruthy()

    expect(poll.method).toBe('GET')
    // The URL-prefix fix: the poll MUST keep /api/v1/server, not collapse to origin.
    expect(poll.url).toContain('https://pushary.com/api/v1/server/decisions/d1')
    expect(poll.url).toContain('wait=')

    expect(r).toEqual({
      decisionId: 'd1',
      status: 'answered',
      answered: true,
      value: 'yes',
      type: 'confirm',
      approved: true,
    })
  })

  it('is fail-closed: a "no" answer is answered but NOT approved', async () => {
    installFetch([
      () => ({ json: { decisionId: 'd2', status: 'pending', answered: false, type: 'confirm' } }),
      () => ({
        json: { decisionId: 'd2', status: 'answered', answered: true, value: 'no', type: 'confirm' },
      }),
    ])
    const r = await px().decisions.ask({ question: 'Delete?', externalId: 'u', timeoutMs: 5000 })
    expect(r.answered).toBe(true)
    expect(r.approved).toBe(false)
  })

  it('is fail-closed: an expired decision is NOT approved', async () => {
    installFetch([
      () => ({ json: { decisionId: 'd3', status: 'pending', answered: false, type: 'confirm' } }),
      () => ({ json: { decisionId: 'd3', status: 'expired', answered: false, value: null, type: 'confirm' } }),
    ])
    const r = await px().decisions.ask({ question: 'Ok?', externalId: 'u', timeoutMs: 5000 })
    expect(r.status).toBe('expired')
    expect(r.approved).toBe(false)
  })

  it('treats a select answer as approved once answered and returns its value', async () => {
    installFetch([
      () => ({ json: { decisionId: 'd4', status: 'pending', answered: false, type: 'select' } }),
      () => ({ json: { decisionId: 'd4', status: 'answered', answered: true, value: 'B', type: 'select' } }),
    ])
    const r = await px().decisions.ask({
      question: 'Pick',
      type: 'select',
      options: ['A', 'B'],
      externalId: 'u',
      timeoutMs: 5000,
    })
    expect(r.value).toBe('B')
    expect(r.approved).toBe(true)
  })

  it('does not poll when the deadline is zero (fire-and-return)', async () => {
    const calls = installFetch([
      () => ({ json: { decisionId: 'd5', status: 'pending', answered: false, type: 'confirm' } }),
    ])
    const r = await px().decisions.ask({ question: 'q', externalId: 'u', timeoutMs: 0 })
    expect(calls).toHaveLength(1)
    expect(r.status).toBe('pending')
    expect(r.approved).toBe(false)
  })

  it('reuses the caller idempotencyKey and generates a unique one per call otherwise', async () => {
    const capture = () =>
      installFetch([
        () => ({ json: { decisionId: 'x', status: 'answered', answered: true, value: 'yes', type: 'confirm' } }),
      ])
    let calls = capture()
    await px().decisions.ask({ question: 'q', externalId: 'u', idempotencyKey: 'my-key', timeoutMs: 0 })
    expect(calls[0].body?.idempotencyKey).toBe('my-key')

    // Two asks with identical text must NOT collapse into one silent auto-approval:
    // without a caller key each call gets its own unique key so it reaches the human.
    calls = capture()
    await px().decisions.ask({ question: 'same', externalId: 'u', timeoutMs: 0 })
    const first = calls[0].body?.idempotencyKey
    calls = capture()
    await px().decisions.ask({ question: 'same', externalId: 'u', timeoutMs: 0 })
    expect(calls[0].body?.idempotencyKey).toBeTruthy()
    expect(calls[0].body?.idempotencyKey).not.toBe(first)
  })
})

describe('decisions reachability (§8.2)', () => {
  it('forwards requireReachable and surfaces reachability from the create response', async () => {
    const calls = installFetch([
      () => ({
        json: {
          decisionId: 'd1',
          status: 'answered',
          answered: true,
          value: 'yes',
          type: 'confirm',
          reachable: true,
          reachableChannels: 2,
          deviceCount: 3,
        },
      }),
    ])
    const r = await px().decisions.ask({
      question: 'Ship it?',
      externalId: 'user_1',
      requireReachable: true,
      timeoutMs: 0,
    })
    expect(calls[0].body?.requireReachable).toBe(true)
    expect(r.reachable).toBe(true)
    expect(r.reachableChannels).toBe(2)
    expect(r.deviceCount).toBe(3)
  })

  it('create passes requireReachable straight through', async () => {
    const calls = installFetch([() => ({ json: { decisionId: 'd', status: 'pending', answered: false } })])
    await px().decisions.create({ question: 'q', externalId: 'u', requireReachable: true })
    expect(calls[0].body?.requireReachable).toBe(true)
  })
})

describe('keys resource (bound-key issuance)', () => {
  it('issue POSTs externalId to /keys and returns the one-time key', async () => {
    const calls = installFetch([
      () => ({
        status: 201,
        json: { apiKey: 'pk_x.secret', keyPrefix: 'pk_x', scope: 'bound', boundExternalId: 'user_9', expiresAt: null },
      }),
    ])
    const r = await px().keys.issue({ externalId: 'user_9', name: 'Session A', expiresInSeconds: 3600 })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('https://pushary.com/api/v1/server/keys')
    expect(calls[0].body).toEqual({ externalId: 'user_9', name: 'Session A', expiresInSeconds: 3600 })
    expect(r.apiKey).toBe('pk_x.secret')
    expect(r.boundExternalId).toBe('user_9')
  })

  it('list unwraps the keys array', async () => {
    const calls = installFetch([() => ({ json: { keys: [{ keyPrefix: 'pk_x', boundExternalId: 'user_9' }] } })])
    const keys = await px().keys.list()
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).toBe('https://pushary.com/api/v1/server/keys')
    expect(keys).toEqual([{ keyPrefix: 'pk_x', boundExternalId: 'user_9' }])
  })

  it('revoke DELETEs the encoded prefix', async () => {
    const calls = installFetch([() => ({ json: { keyPrefix: 'pk_x', revoked: true } })])
    const r = await px().keys.revoke('pk_x')
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toBe('https://pushary.com/api/v1/server/keys/pk_x')
    expect(r.revoked).toBe(true)
  })
})

describe('parseDecisionCallback (§8.3)', () => {
  it('parses answer, value alias, and context', () => {
    const body = JSON.stringify({
      correlationId: 'c_1',
      answer: 'yes',
      value: 'yes',
      answeredAt: '2026-07-17T00:00:00Z',
      context: 'run_42',
    })
    const parsed = parseDecisionCallback(body)
    expect(parsed).toEqual({
      correlationId: 'c_1',
      answer: 'yes',
      value: 'yes',
      answeredAt: '2026-07-17T00:00:00Z',
      context: 'run_42',
    })
  })

  it('defaults value to answer and omits absent context', () => {
    const parsed = parseDecisionCallback(JSON.stringify({ correlationId: 'c_1', answer: 'no' }))
    expect(parsed?.value).toBe('no')
    expect(parsed && 'context' in parsed).toBe(false)
  })

  it('returns null for a non-callback or malformed body', () => {
    expect(parseDecisionCallback('{"answer":"yes"}')).toBeNull()
    expect(parseDecisionCallback('not json')).toBeNull()
    expect(parseDecisionCallback('[1,2,3]')).toBeNull()
  })

  it('exposes the signature header constant', () => {
    expect(SIGNATURE_HEADER).toBe('x-pushary-signature')
  })
})

describe('deterministicKey', () => {
  it('is stable and differs by input', () => {
    expect(deterministicKey(['a', 'b'])).toBe(deterministicKey(['a', 'b']))
    expect(deterministicKey(['a', 'b'])).not.toBe(deterministicKey(['a', 'c']))
    expect(deterministicKey(['a', 'b'])).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('isApproved', () => {
  it('confirm: affirmative only', () => {
    expect(isApproved({ status: 'answered', type: 'confirm', value: 'yes' })).toBe(true)
    expect(isApproved({ status: 'answered', type: 'confirm', value: 'no' })).toBe(false)
    expect(isApproved({ status: 'pending', type: 'confirm', value: null })).toBe(false)
    expect(isApproved({ status: 'expired', type: 'confirm', value: null })).toBe(false)
  })
  it('select/input: approved when answered', () => {
    expect(isApproved({ status: 'answered', type: 'select', value: 'A' })).toBe(true)
    expect(isApproved({ status: 'answered', type: 'input', value: 'text' })).toBe(true)
    expect(isApproved({ status: 'cancelled', type: 'input', value: null })).toBe(false)
  })
})

describe('authorize', () => {
  it('returns a policy allow without asking anyone', async () => {
    const calls = installFetch([
      () => ({ json: { verdict: 'allow', policy: 'refund.create', reason: 'Allowed by policy rule refund.create.', authorizationId: 'a1' } }),
    ])
    const p = createPusharyServer({ apiKey: 'pk_a.sk_b', baseUrl: 'https://x/api/v1/server' })
    const r = await p.authorize({ toolName: 'refund.create', externalId: 'u1' })
    expect(r).toMatchObject({ approved: true, resolvedBy: 'policy', policy: 'refund.create', decisionId: null, authorizationId: 'a1' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('/authorize')
  })

  it('returns a policy deny without asking anyone', async () => {
    const calls = installFetch([
      () => ({ json: { verdict: 'deny', policy: 'infrastructure.delete', reason: 'Denied by policy rule infrastructure.delete.', authorizationId: 'a2' } }),
    ])
    const p = createPusharyServer({ apiKey: 'pk_a.sk_b', baseUrl: 'https://x/api/v1/server' })
    const r = await p.authorize({ toolName: 'infrastructure.delete', externalId: 'u1' })
    expect(r).toMatchObject({ approved: false, resolvedBy: 'policy' })
    expect(calls).toHaveLength(1)
  })

  it('asks a person when policy defers, and labels the ask with the action', async () => {
    const calls = installFetch([
      (c) => c.url.includes('/authorize')
        ? { json: { verdict: 'requires_human', policy: null, reason: 'no rule', authorizationId: null } }
        : { json: { decisionId: 'd1', status: 'answered', answered: true, value: 'yes', type: 'confirm' } },
    ])
    const p = createPusharyServer({ apiKey: 'pk_a.sk_b', baseUrl: 'https://x/api/v1/server' })
    const r = await p.authorize({ toolName: 'refund.create', toolTarget: 'order_1', externalId: 'u1' })
    expect(r).toMatchObject({ approved: true, resolvedBy: 'human', decisionId: 'd1' })
    const ask = calls.find((c) => c.url.includes('/decisions'))
    expect(ask?.body?.toolName).toBe('refund.create')
    expect(ask?.body?.question).toBe('Approve refund.create order_1?')
  })

  it('fails closed when policy defers and nobody answers', async () => {
    installFetch([
      (c) => c.url.includes('/authorize')
        ? { json: { verdict: 'requires_human', policy: null, reason: 'no rule', authorizationId: null } }
        : { json: { decisionId: 'd2', status: 'pending', answered: false, value: null, type: 'confirm' } },
    ])
    const p = createPusharyServer({ apiKey: 'pk_a.sk_b', baseUrl: 'https://x/api/v1/server' })
    const r = await p.authorize({ toolName: 'refund.create', externalId: 'u1', timeoutMs: 0 })
    expect(r.approved).toBe(false)
    expect(r.reason).toContain('Nobody answered')
  })
})

describe('the structured action model', () => {
  it('sends the same subject to the evaluation and to the ask it falls through to', async () => {
    const calls = installFetch([
      (c) => c.url.includes('/authorize')
        ? { json: { verdict: 'requires_human', policy: null, reason: 'no rule', authorizationId: null } }
        : { json: { decisionId: 'd9', status: 'answered', answered: true, value: 'yes', type: 'confirm' } },
    ])
    const p = createPusharyServer({ apiKey: 'pk_a.sk_b', baseUrl: 'https://x/api/v1/server' })
    await p.authorize({
      toolName: 'refund.create',
      toolTarget: 'order_1',
      actor: 'user:u_44',
      environment: 'production',
      parameters: { amount: 480, currency: 'USD' },
      externalId: 'u1',
    })

    const evaluate = calls.find((c) => c.url.includes('/authorize'))
    const ask = calls.find((c) => c.url.includes('/decisions'))
    // A decision recorded under a different description than the one policy saw
    // would make the audit trail lie about what was evaluated.
    for (const call of [evaluate, ask]) {
      expect(call?.body?.actor).toBe('user:u_44')
      expect(call?.body?.environment).toBe('production')
      expect(call?.body?.parameters).toEqual({ amount: 480, currency: 'USD' })
    }
  })

  it('omits the new fields entirely when the caller sends none', async () => {
    const calls = installFetch([
      () => ({ json: { verdict: 'allow', policy: 'refund.create', reason: 'ok', authorizationId: 'a1' } }),
    ])
    const p = createPusharyServer({ apiKey: 'pk_a.sk_b', baseUrl: 'https://x/api/v1/server' })
    await p.authorize({ toolName: 'refund.create', externalId: 'u1' })

    const body = calls[0]?.body ?? {}
    for (const key of ['actor', 'environment', 'parameters']) {
      expect(body[key]).toBeUndefined()
    }
  })

  it('carries the subject through decisions.ask on its own', async () => {
    const calls = installFetch([
      () => ({ json: { decisionId: 'd1', status: 'answered', answered: true, value: 'yes', type: 'confirm' } }),
    ])
    const p = createPusharyServer({ apiKey: 'pk_a.sk_b', baseUrl: 'https://x/api/v1/server' })
    await p.decisions.ask({
      question: 'Approve?',
      actor: 'team:billing',
      environment: 'staging',
      parameters: { amount: 12 },
    })
    expect(calls[0]?.body?.actor).toBe('team:billing')
    expect(calls[0]?.body?.environment).toBe('staging')
    expect(calls[0]?.body?.parameters).toEqual({ amount: 12 })
  })
})

describe('ask deadline', () => {
  it('returns the existing pending decision on poll timeout, but propagates caller cancellation', async () => {
    for (const cancel of [false, true]) {
      const controller = new AbortController()
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        if (init?.method === 'POST') return Response.json({ decisionId: 'pending1', status: 'pending', answered: false })
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
          if (cancel) controller.abort(new Error('Caller stopped'))
        })
      }) as typeof fetch
      const pending = px().decisions.ask({ question: 'Approve?', timeoutMs: 10, signal: controller.signal })
      if (cancel) await expect(pending).rejects.toThrow('Caller stopped')
      else expect(await pending).toMatchObject({ decisionId: 'pending1', status: 'pending', approved: false })
    }
  })

  it('aborts a stalled create within the caller budget', async () => {
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('request was not aborted')), 100)
      init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal?.reason) }, { once: true })
    })) as typeof fetch
    await expect(px().decisions.ask({ question: 'Approve?', timeoutMs: 10 })).rejects.toMatchObject({ name: 'TimeoutError' })
  })
})


describe('decisions.list', () => {
  it('passes the opaque cursor and recipient filters unchanged and preserves terminal statuses', async () => {
    const response = { decisions: [{ decisionId: 'cancelled', status: 'cancelled', answered: false }, { decisionId: 'expired', status: 'expired', answered: false }], nextCursor: 'next-opaque_cursor' }
    const calls = installFetch([() => ({ json: response })])
    expect(await px().decisions.list({ externalId: 'customer & 1', cursor: 'opaque_cursor-1', limit: 7 })).toEqual(response)
    const url = new URL(calls[0].url)
    expect(calls[0].method).toBe('GET')
    expect(url.pathname).toBe('/api/v1/server/decisions')
    expect(url.searchParams.get('externalId')).toBe('customer & 1')
    expect(url.searchParams.get('cursor')).toBe('opaque_cursor-1')
    expect(url.searchParams.get('limit')).toBe('7')
  })
})
