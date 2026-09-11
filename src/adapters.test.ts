import { describe, it, expect, afterEach } from 'vitest'
import { createHmac } from 'crypto'
import {
  createAdapterKernel,
  decisionFingerprint,
  deriveParameters,
  describeAnswer,
  idempotencyKeyFor,
  isAffirmative,
  renderApprovalQuestion,
  resolvePusharyCallback,
  type AskResult,
  type AuthorizationEvaluation,
} from './adapters'
import type { ConsumedAuthorization } from './types'

interface Recorded {
  readonly url: string
  readonly method: string
  readonly body: Record<string, unknown> | undefined
}
type Responder = (call: Recorded) => unknown

// A non-2xx reply, so a responder can say "this endpoint refused" rather than only
// what it returned.
class Fails {
  constructor(
    readonly status: number,
    readonly body: unknown = {},
  ) {}
}

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
    const json = responders[Math.min(i, responders.length - 1)](call)
    i += 1
    if (json instanceof Fails) {
      return { ok: false, status: json.status, statusText: '', json: async () => json.body } as Response
    }
    return { ok: true, status: 200, json: async () => json } as Response
  }) as typeof fetch
  return calls
}
afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.PUSHARY_API_KEY
})

const CONFIG = { apiKey: 'pk_x.sk_y', baseUrl: 'https://pushary.com/api/v1/server' }
const SECRET = 'whsec_test'
const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex')

const kernel = createAdapterKernel('the Acme helpers')

const ask = (r: Partial<AskResult>): AskResult => ({
  decisionId: 'd1',
  status: 'answered',
  answered: true,
  value: 'yes',
  type: 'confirm',
  approved: true,
  ...r,
})

const evaluated = (r: Partial<AuthorizationEvaluation> = {}): AuthorizationEvaluation => ({
  verdict: 'requires_human',
  policy: null,
  reason: 'No policy rule names this action, so a person decides.',
  authorizationId: null,
  ...r,
})

const consumed = (r: Partial<ConsumedAuthorization> = {}): ConsumedAuthorization => ({
  permitId: 'permit_1',
  authority: { kind: 'policy', rulePattern: 'refund.create' },
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  ...r,
})

// The gate makes two calls and protect makes as many as four. Route by path so a
// test says which endpoint it is answering instead of depending on call order.
const routed = (evaluation: unknown, answer: unknown, permit: unknown = consumed()): Responder =>
  (call) => {
    if (call.url.endsWith('/authorize')) return evaluation
    if (call.url.endsWith('/receipt')) return { permitId: 'permit_1', executionState: 'succeeded' }
    if (call.url.endsWith('/authorizations/consume')) return permit
    return answer
  }

const isAuthorize = (c: Recorded) => c.url.endsWith('/authorize')
const isDecision = (c: Recorded) => c.url.endsWith('/decisions')
const isConsume = (c: Recorded) => c.url.endsWith('/authorizations/consume')
const isReceipt = (c: Recorded) => c.url.endsWith('/receipt')
const decisionCall = (calls: readonly Recorded[]) => calls.find(isDecision)

const GATED = {
  toolName: 'issue_refund',
  callId: 'call_1',
  sessionId: 'sess_1',
  question: 'Approve?',
  externalId: 'user_1',
} as const

describe('createAdapterKernel', () => {
  it('names the calling adapter when no key is configured', () => {
    expect(() => kernel.client({})).toThrow(/the Acme helpers/)
  })

  it('falls back to PUSHARY_API_KEY', () => {
    process.env.PUSHARY_API_KEY = 'pk_env.sk_env'
    expect(() => kernel.client({})).not.toThrow()
  })

  it('names the calling adapter when there is no end-user to ask', () => {
    expect(() => kernel.requireExternalId(undefined)).toThrow(/no end-user to ask/)
    expect(() => kernel.requireExternalId(undefined)).toThrow(/the Acme helpers/)
    expect(kernel.requireExternalId('user_1')).toBe('user_1')
    expect(kernel.requireExternalId(' user_1 ')).toBe(' user_1 ')
    expect(() => kernel.requireExternalId('x'.repeat(257))).toThrow(/256/)
  })
})

describe('askExternalUser', () => {
  it('preserves an explicit operation key on retry', async () => {
    const calls = installFetch([() => ask({})])
    await kernel.askExternalUser(CONFIG, {
      question: 'Refund?',
      externalId: 'user_1',
      node: 'approval',
      idempotencyKey: 'operation-1',
    })
    expect(calls[0]?.body?.idempotencyKey).toBe(
      'operation-1',
    )
  })

  it('labels the decision with the node, and leaves an unnamed ask unlabelled', async () => {
    const named = installFetch([() => ask({})])
    await kernel.askExternalUser(CONFIG, {
      question: 'Refund?',
      externalId: 'user_1',
      node: 'refund.create',
    })
    expect(named[0]?.body?.toolName).toBe('refund.create')

    const unnamed = installFetch([() => ask({})])
    await kernel.askExternalUser(CONFIG, { question: 'Refund?', externalId: 'user_1' })
    expect(unnamed[0]?.body?.toolName).toBeUndefined()
  })

  it('keys two different nodes apart so one answer never stands in for the other', () => {
    const a = idempotencyKeyFor({ question: 'Refund?', externalId: 'u', node: 'one' })
    const b = idempotencyKeyFor({ question: 'Refund?', externalId: 'u', node: 'two' })
    expect(a).not.toBe(b)
  })
})

describe('createDurableDecision', () => {
  it('preserves customer review fields through both blocking and durable paths', async () => {
    const calls = installFetch([() => ask({})])
    const input = {
      question: 'Which supplier?', externalId: 'customer_1', type: 'select' as const,
      options: ['Acme', 'Other'], idempotencyKey: 'run_1:select', toolName: 'choose_supplier',
      toolTarget: 'po_1', actor: 'buyer', environment: 'production', parameters: { quantity: 2 },
      presentation: { label: 'Supplier', effect: 'Choose who receives the order' },
      expiresInSeconds: 3600, requireReachable: true, placeholder: 'Choose a supplier', approvalUrl: true,
      context: 'Draft revision 2', callbackUrl: 'https://agent.example.com/answer',
    }
    await kernel.askExternalUser({ ...CONFIG, timeoutMs: 0 }, input)
    await kernel.createDurableDecision(CONFIG, input)
    expect(calls).toHaveLength(2)
    for (const call of calls) expect(call.body).toMatchObject(input)
  })

  it('opens the decision without waiting and echoes the id as the correlation id', async () => {
    const calls = installFetch([() => ({ decisionId: 'd9', status: 'pending' })])
    const created = await kernel.createDurableDecision(CONFIG, {
      question: 'Ship it?',
      externalId: 'user_1',
      callbackUrl: 'https://agent.example.com/hook',
      idempotencyKey: 'operation-1',
    })
    expect(calls[0]?.body?.wait).toBe(false)
    expect(calls[0]?.body?.callbackUrl).toBe('https://agent.example.com/hook')
    expect(created).toMatchObject({ decisionId: 'd9', correlationId: 'd9', status: 'pending' })
  })
})

describe('createGate', () => {
  it('binds a human answer to the recipient and complete action while preserving reordered retries', async () => {
    const calls = installFetch([() => ask({})])
    const gate = kernel.createGate({ ...CONFIG, timeoutMs: 0, policy: false })
    await gate({ ...GATED, input: { order: { id: 'po_1', quantity: 2 }, currency: 'EUR' } })
    await gate({ ...GATED, input: { currency: 'EUR', order: { quantity: 2, id: 'po_1' } } })
    await gate({ ...GATED, input: { order: { id: 'po_1', quantity: 3 }, currency: 'EUR' } })
    await gate({ ...GATED, externalId: 'user_2', input: { order: { id: 'po_1', quantity: 2 }, currency: 'EUR' } })
    const keys = calls.map((call) => call.body?.idempotencyKey)
    expect(keys[0]).toBe(keys[1])
    expect(new Set([keys[0], keys[2], keys[3]]).size).toBe(3)
  })

  it('keeps the full displayed subject when a human is required', async () => {
    const calls = installFetch([() => ask({})])
    const gate = kernel.createGate({ ...CONFIG, timeoutMs: 0, policy: false })
    const subject = { toolTarget: 'order_9', parameters: { amount: 4800 }, presentation: { label: 'Refund', effect: 'Return payment' } }
    const result = await gate({ ...GATED, ...subject })
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toMatchObject(subject)
    expect(result).toMatchObject({ authorization: { toolTarget: 'order_9', parameters: subject.parameters } })
  })

  it('refuses unrepresentable action identity before opening a review', async () => {
    const calls = installFetch([() => ask({})])
    const gate = kernel.createGate({ ...CONFIG, policy: false })
    await expect(gate({ ...GATED, callId: '' })).rejects.toThrow(/stable tool call ID/)
    await expect(gate({ ...GATED, externalId: '' })).rejects.toThrow(/no end-user to ask/)
    await expect(gate({ ...GATED, input: { amount: NaN } })).rejects.toThrow(/decision identity/)
    expect(calls).toHaveLength(0)
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    expect(() => decisionFingerprint(cycle)).toThrow(/decision identity/)
    expect(() => decisionFingerprint(new Date())).toThrow(/plain JSON/)
  })

  it('asks a person when no rule names the action, and approves on yes', async () => {
    const calls = installFetch([routed(evaluated(), ask({}))])
    const gate = kernel.createGate({ ...CONFIG, timeoutMs: 0 })
    const decision = await gate(GATED)
    expect(decision.approved).toBe(true)
    // Bound to the decision that settled it, and to the subject the ask
    // recorded: toolName and the recipient, since the evaluation failed to add
    // the rest.
    expect(decision.approved ? decision.authorization : null).toEqual({
      authorizationId: 'd1',
      toolName: 'issue_refund',
      externalId: 'user_1',
    })
    expect(calls.filter(isAuthorize)).toHaveLength(1)
    expect(calls.filter(isDecision)).toHaveLength(1)
  })

  it('allows without opening a decision or paging anyone', async () => {
    const calls = installFetch([
      routed(evaluated({ verdict: 'allow', policy: 'issue_refund', authorizationId: 'authz_1' }), ask({})),
    ])
    const gate = kernel.createGate({ ...CONFIG, timeoutMs: 0 })
    const decision = await gate(GATED)
    expect(decision.approved).toBe(true)
    expect(decision.approved ? decision.authorization?.authorizationId : null).toBe('authz_1')
    expect(calls.filter(isDecision)).toHaveLength(0)
  })

  it('carries no binding when the server would not name the authorization', async () => {
    // An older deployment. protect() refuses rather than running unbound; the
    // gate itself still approves, because a caller with its own execution path
    // is no worse off than it was before permits existed.
    installFetch([routed(evaluated({ verdict: 'allow', policy: 'issue_refund' }), ask({}))])
    const gate = kernel.createGate({ ...CONFIG, timeoutMs: 0 })
    const decision = await gate(GATED)
    expect(decision).toEqual({ approved: true })
  })

  it('denies with the rule the model can read, and never asks', async () => {
    const calls = installFetch([
      routed(
        evaluated({ verdict: 'deny', policy: 'issue_refund', reason: 'Denied by policy rule issue_refund.' }),
        ask({}),
      ),
    ])
    const gate = kernel.createGate({ ...CONFIG, timeoutMs: 0 })
    const decision = await gate(GATED)
    expect(decision.approved).toBe(false)
    expect(decision.approved ? '' : decision.reason).toBe(
      'Denied by policy rule issue_refund. Do not retry the same action.',
    )
    expect(calls.filter(isDecision)).toHaveLength(0)
  })

  it('falls back to asking a person when the site cannot evaluate policy', async () => {
    const calls = installFetch([routed(new Fails(403, { error: 'Authorization requires the Partner plan' }), ask({}))])
    const gate = kernel.createGate({ ...CONFIG, timeoutMs: 0 })
    expect((await gate(GATED)).approved).toBe(true)
    expect(calls.filter(isDecision)).toHaveLength(1)
  })

  it('sends the pre-policy ask shape when the evaluation failed', async () => {
    const calls = installFetch([routed(new Fails(500), ask({}))])
    const gate = kernel.createGate({ ...CONFIG, timeoutMs: 0 })
    await gate({
      ...GATED, toolTarget: 'order_9', input: { amount: 4800 },
      presentation: { label: 'Refund', effect: 'Return payment', changes: [{ parameter: 'amount', label: 'Amount', format: { kind: 'currency', currency: 'EUR' } }] },
    })
    const body = decisionCall(calls)?.body
    expect(body?.toolName).toBe('issue_refund')
    expect(body?.toolTarget).toBeUndefined()
    expect(body?.parameters).toBeUndefined()
    expect(body?.presentation).toBeUndefined()
  })

  it('never asks policy when the gate opts out', async () => {
    const calls = installFetch([() => ask({})])
    const gate = kernel.createGate({ ...CONFIG, timeoutMs: 0, policy: false })
    expect((await gate(GATED)).approved).toBe(true)
    expect(calls.filter(isAuthorize)).toHaveLength(0)
    expect(calls.filter(isDecision)).toHaveLength(1)
  })

  it('fails closed when nobody answers, with a reason the model can read', async () => {
    installFetch([
      routed(evaluated(), ask({ status: 'pending', answered: false, value: null, approved: false })),
    ])
    const gate = kernel.createGate({ ...CONFIG, timeoutMs: 0 })
    const decision = await gate(GATED)
    expect(decision).toMatchObject({ approved: false })
    expect(decision.approved ? '' : decision.reason).toContain('No answer')
  })

  it('distinguishes a refusal from silence', async () => {
    installFetch([routed(evaluated(), ask({ value: 'no', approved: false }))])
    const gate = kernel.createGate({ ...CONFIG, timeoutMs: 0 })
    const decision = await gate(GATED)
    expect(decision.approved ? '' : decision.reason).toContain('denied this action')
  })

  it('labels both calls with the gated tool', async () => {
    const calls = installFetch([routed(evaluated(), ask({}))])
    const gate = kernel.createGate({ ...CONFIG, timeoutMs: 0 })
    await gate({ ...GATED, toolName: 'refund.create' })
    expect(calls.find(isAuthorize)?.body?.toolName).toBe('refund.create')
    expect(decisionCall(calls)?.body?.toolName).toBe('refund.create')
  })

  it('always asks confirm, never a free-text type', async () => {
    const calls = installFetch([routed(evaluated(), ask({}))])
    const gate = kernel.createGate({ ...CONFIG, timeoutMs: 0 })
    await gate(GATED)
    expect(decisionCall(calls)?.body?.type).toBe('confirm')
  })

  it('keys on session, call and tool so a replayed call does not ask twice', async () => {
    const calls = installFetch([routed(evaluated(), ask({}))])
    const gate = kernel.createGate({ ...CONFIG, timeoutMs: 0 })
    await gate(GATED)
    await gate(GATED)
    const keys = calls.filter(isDecision).map((c) => c.body?.idempotencyKey)
    expect(keys[0]).toBe(keys[1])

    const calls2 = installFetch([routed(evaluated(), ask({}))])
    await gate(GATED)
    await gate({ ...GATED, callId: 'c2' })
    const keys2 = calls2.filter(isDecision).map((c) => c.body?.idempotencyKey)
    expect(keys2[0]).not.toBe(keys2[1])
  })

  it('gives policy the action arguments, and carries them into the ask', async () => {
    const calls = installFetch([routed(evaluated(), ask({}))])
    const gate = kernel.createGate({ ...CONFIG, timeoutMs: 0 })
    await gate({ ...GATED, toolTarget: 'order_9', input: { amount: 4800, currency: 'EUR' } })
    expect(calls.find(isAuthorize)?.body?.parameters).toEqual({ amount: 4800, currency: 'EUR' })
    expect(calls.find(isAuthorize)?.body?.toolTarget).toBe('order_9')
    expect(decisionCall(calls)?.body?.parameters).toEqual({ amount: 4800, currency: 'EUR' })
  })

  it('prefers facts the adapter states over facts derived from the input', async () => {
    const calls = installFetch([routed(evaluated(), ask({}))])
    const gate = kernel.createGate({ ...CONFIG, timeoutMs: 0 })
    await gate({ ...GATED, input: { amount: 1 }, parameters: { amount: 4800 } })
    expect(calls.find(isAuthorize)?.body?.parameters).toEqual({ amount: 4800 })
  })

  it('sends no arguments at all when the input will not fit the bounds', async () => {
    const calls = installFetch([routed(evaluated(), ask({}))])
    const gate = kernel.createGate({ ...CONFIG, timeoutMs: 0 })
    await gate({ ...GATED, input: { amount: 4800, customer: { id: 'c_1' } } })
    expect(calls.find(isAuthorize)?.body?.parameters).toBeUndefined()
  })

  it('refuses at construction when no key is configured', () => {
    expect(() => kernel.createGate({})).toThrow(/the Acme helpers/)
  })
})

describe('protect', () => {
  const ACTION = {
    action: 'refund.create',
    target: 'order_4471',
    externalId: 'user_1',
    callId: 'call_1',
    runId: 'run_1',
  } as const

  it('runs the action when a rule allows it, and pages nobody', async () => {
    const calls = installFetch([routed(evaluated({ verdict: 'allow', policy: 'refund.create', authorizationId: 'authz_1' }), ask({}))])
    const protect = kernel.protect({ ...CONFIG, timeoutMs: 0 })
    let ran = 0
    const outcome = await protect({ ...ACTION, run: async () => { ran += 1; return 'refunded' } })
    expect(outcome).toEqual({ ok: true, result: 'refunded' })
    expect(ran).toBe(1)
    expect(calls.filter(isDecision)).toHaveLength(0)
  })

  it('does not run the action on a policy denial, and says why', async () => {
    installFetch([
      routed(
        evaluated({ verdict: 'deny', policy: 'refund.create', reason: 'Denied by policy rule refund.create.' }),
        ask({}),
      ),
    ])
    const protect = kernel.protect({ ...CONFIG, timeoutMs: 0 })
    let ran = 0
    const outcome = await protect({ ...ACTION, run: async () => { ran += 1; return 'refunded' } })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok ? '' : outcome.reason).toContain('Denied by policy rule refund.create.')
    expect(ran).toBe(0)
  })

  it('runs the action when a person approves the escalation', async () => {
    installFetch([routed(evaluated(), ask({}))])
    const protect = kernel.protect({ ...CONFIG, timeoutMs: 0 })
    const outcome = await protect({ ...ACTION, run: async () => 'refunded' })
    expect(outcome).toEqual({ ok: true, result: 'refunded' })
  })

  it('does not run the action when nobody answers', async () => {
    installFetch([
      routed(evaluated(), ask({ status: 'pending', answered: false, value: null, approved: false })),
    ])
    const protect = kernel.protect({ ...CONFIG, timeoutMs: 0 })
    let ran = 0
    const outcome = await protect({ ...ACTION, run: async () => { ran += 1; return 'refunded' } })
    expect(outcome.ok).toBe(false)
    expect(ran).toBe(0)
  })

  it('gives policy the action, its target and its facts', async () => {
    const calls = installFetch([routed(evaluated(), ask({}))])
    const protect = kernel.protect({ ...CONFIG, timeoutMs: 0 })
    await protect({
      ...ACTION,
      actor: 'user:u_44',
      environment: 'production',
      facts: { amount: 4800, currency: 'EUR' },
      run: async () => null,
    })
    const body = calls.find(isAuthorize)?.body
    expect(body?.toolName).toBe('refund.create')
    expect(body?.toolTarget).toBe('order_4471')
    expect(body?.actor).toBe('user:u_44')
    expect(body?.environment).toBe('production')
    expect(body?.parameters).toEqual({ amount: 4800, currency: 'EUR' })
  })

  it('asks a readable question without one being written', async () => {
    const calls = installFetch([routed(evaluated(), ask({}))])
    const protect = kernel.protect({ ...CONFIG, timeoutMs: 0 })
    await protect({ ...ACTION, run: async () => null })
    expect(decisionCall(calls)?.body?.question).toBe('Approve refund.create order_4471?')
  })

  it('lets the action\'s own failure through rather than reporting it as a refusal', async () => {
    // An agent reading `ok: false` cannot tell a denied refund from a refund that
    // was authorized and then failed, and those want opposite next moves.
    installFetch([routed(evaluated({ verdict: 'allow', policy: 'refund.create', authorizationId: 'authz_1' }), ask({}))])
    const protect = kernel.protect({ ...CONFIG, timeoutMs: 0 })
    await expect(
      protect({ ...ACTION, run: async () => { throw new Error('stripe is down') } }),
    ).rejects.toThrow('stripe is down')
  })

  it('resolves a replayed action to the same decision instead of asking twice', async () => {
    const calls = installFetch([routed(evaluated(), ask({}))])
    const protect = kernel.protect({ ...CONFIG, timeoutMs: 0 })
    await protect({ ...ACTION, run: async () => null })
    await protect({ ...ACTION, run: async () => null })
    const keys = calls.filter(isDecision).map((c) => c.body?.idempotencyKey)
    expect(keys[0]).toBe(keys[1])
  })

  it('refuses at construction when no key is configured', () => {
    expect(() => kernel.protect({})).toThrow(/the Acme helpers/)
  })

  it('spends the authorization before the action runs, never after', async () => {
    const order: string[] = []
    const calls = installFetch([
      routed(evaluated({ verdict: 'allow', policy: 'refund.create', authorizationId: 'authz_1' }), ask({})),
    ])
    const protect = kernel.protect({ ...CONFIG, timeoutMs: 0 })
    await protect({
      ...ACTION,
      run: async () => {
        order.push('ran')
        return null
      },
    })
    const consumeIndex = calls.findIndex(isConsume)
    const receiptIndex = calls.findIndex(isReceipt)
    expect(consumeIndex).toBeGreaterThanOrEqual(0)
    expect(order).toEqual(['ran'])
    // A permit spent after the run would leave the window this exists to close:
    // the crash between the two loses the record that it ran.
    expect(receiptIndex).toBeGreaterThan(consumeIndex)
  })

  it('re-states the action it is about to run, so the server can refuse a mutation', async () => {
    const calls = installFetch([
      routed(evaluated({ verdict: 'allow', policy: 'refund.create', authorizationId: 'authz_1' }), ask({})),
    ])
    const protect = kernel.protect({ ...CONFIG, timeoutMs: 0 })
    await protect({
      ...ACTION,
      actor: 'user:u_44',
      environment: 'production',
      facts: { amount: 4800 },
      run: async () => null,
    })
    expect(calls.find(isConsume)?.body).toEqual({
      authorizationId: 'authz_1',
      toolName: 'refund.create',
      toolTarget: 'order_4471',
      actor: 'user:u_44',
      environment: 'production',
      externalId: 'user_1',
      parameters: { amount: 4800 },
    })
  })

  it('does not run the action when the authorization was already spent', async () => {
    const calls = installFetch([
      routed(
        evaluated({ verdict: 'allow', policy: 'refund.create', authorizationId: 'authz_1' }),
        ask({}),
        new Fails(409, {
          error: 'The authorization was already consumed',
          refusal: 'already_consumed',
          executionState: 'succeeded',
        }),
      ),
    ])
    const protect = kernel.protect({ ...CONFIG, timeoutMs: 0 })
    let ran = 0
    const outcome = await protect({ ...ACTION, run: async () => { ran += 1; return null } })
    expect(ran).toBe(0)
    expect(outcome.ok).toBe(false)
    // Worded to stop the model, not to invite a retry: something already ran it.
    expect(outcome.ok ? '' : outcome.reason).toContain('must not run again')
    expect(calls.filter(isReceipt)).toHaveLength(0)
  })

  it('does not run the action when the subject no longer matches what was approved', async () => {
    installFetch([
      routed(
        evaluated({ verdict: 'allow', policy: 'refund.create', authorizationId: 'authz_1' }),
        ask({}),
        new Fails(409, {
          error: 'The action does not match the action that was authorized',
          refusal: 'action_mismatch',
        }),
      ),
    ])
    const protect = kernel.protect({ ...CONFIG, timeoutMs: 0 })
    let ran = 0
    const outcome = await protect({ ...ACTION, run: async () => { ran += 1; return null } })
    expect(ran).toBe(0)
    expect(outcome.ok ? '' : outcome.reason).toContain('does not match')
  })

  it('does not run the action when the permit could not be confirmed', async () => {
    // A transport failure is not a refusal, and it is not permission either. The
    // only safe answer is not to run: an unissued refund can be asked for again.
    installFetch([
      routed(
        evaluated({ verdict: 'allow', policy: 'refund.create', authorizationId: 'authz_1' }),
        ask({}),
        new Fails(500, {}),
      ),
    ])
    const protect = kernel.protect({ ...CONFIG, timeoutMs: 0 })
    let ran = 0
    const outcome = await protect({ ...ACTION, run: async () => { ran += 1; return null } })
    expect(ran).toBe(0)
    expect(outcome.ok ? '' : outcome.reason).toContain('could not be confirmed')
  })

  it('does not run an approval the server would not bind', async () => {
    installFetch([routed(evaluated({ verdict: 'allow', policy: 'refund.create' }), ask({}))])
    const protect = kernel.protect({ ...CONFIG, timeoutMs: 0 })
    let ran = 0
    const outcome = await protect({ ...ACTION, run: async () => { ran += 1; return null } })
    expect(ran).toBe(0)
    expect(outcome.ok ? '' : outcome.reason).toContain('could not be bound')
  })

  it('records what the action did', async () => {
    const calls = installFetch([
      routed(evaluated({ verdict: 'allow', policy: 'refund.create', authorizationId: 'authz_1' }), ask({})),
    ])
    const protect = kernel.protect({ ...CONFIG, timeoutMs: 0 })
    await protect({ ...ACTION, run: async () => 'refunded' })
    const receipt = calls.find(isReceipt)
    expect(receipt?.url).toContain('/authorizations/permit_1/receipt')
    expect(receipt?.body?.outcome).toBe('succeeded')
  })

  it('records a failure against the same permit, and still lets the error through', async () => {
    const calls = installFetch([
      routed(evaluated({ verdict: 'allow', policy: 'refund.create', authorizationId: 'authz_1' }), ask({})),
    ])
    const protect = kernel.protect({ ...CONFIG, timeoutMs: 0 })
    await expect(
      protect({ ...ACTION, run: async () => { throw new Error('stripe is down') } }),
    ).rejects.toThrow('stripe is down')
    const receipt = calls.find(isReceipt)
    expect(receipt?.body?.outcome).toBe('failed')
    expect(receipt?.body?.summary).toBe('stripe is down')
  })

  it('does not turn a completed action into an error because the receipt failed', async () => {
    // The action already happened. Failing the caller here would invite them to
    // issue it again, which is the outcome this whole path prevents.
    installFetch([
      (call) =>
        call.url.endsWith('/authorize')
          ? evaluated({ verdict: 'allow', policy: 'refund.create', authorizationId: 'authz_1' })
          : call.url.endsWith('/receipt')
            ? new Fails(500, {})
            : consumed(),
    ])
    const protect = kernel.protect({ ...CONFIG, timeoutMs: 0 })
    expect(await protect({ ...ACTION, run: async () => 'refunded' })).toEqual({
      ok: true,
      result: 'refunded',
    })
  })
})

describe('deriveParameters', () => {
  it('carries scalars through unchanged', () => {
    expect(deriveParameters({ amount: 4800, currency: 'EUR', urgent: true })).toEqual({
      amount: 4800,
      currency: 'EUR',
      urgent: true,
    })
  })

  it('is all or nothing, so one unrepresentable entry never softens a rule', () => {
    // A rule reading `amount >= 500` would stop denying if `amount` alone survived.
    expect(deriveParameters({ amount: 4800, meta: { nested: true } })).toBeUndefined()
    expect(deriveParameters({ amount: 4800, tags: ['a'] })).toBeUndefined()
    expect(deriveParameters({ amount: Number.NaN })).toBeUndefined()
    expect(deriveParameters({ amount: 4800, note: 'x'.repeat(201) })).toBeUndefined()
    expect(deriveParameters({ ['k'.repeat(65)]: 1 })).toBeUndefined()
    expect(
      deriveParameters(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i]))),
    ).toBeUndefined()
  })

  it('has nothing to derive from a non-object input', () => {
    expect(deriveParameters(undefined)).toBeUndefined()
    expect(deriveParameters(null)).toBeUndefined()
    expect(deriveParameters('refund')).toBeUndefined()
    expect(deriveParameters([1, 2])).toBeUndefined()
    expect(deriveParameters({})).toBeUndefined()
  })
})

describe('renderApprovalQuestion', () => {
  it('shows the tool and its input so the approver knows what they are approving', () => {
    const q = renderApprovalQuestion('issue_refund', { amount: 480 })
    expect(q).toContain('issue_refund')
    expect(q).toContain('480')
  })

  it('truncates a large input rather than sending it whole to a lock screen', () => {
    const q = renderApprovalQuestion('issue_refund', { blob: 'x'.repeat(1000) })
    expect(q.length).toBeLessThan(400)
    expect(q).toContain('...')
  })

  it('handles an input the tool did not supply', () => {
    expect(renderApprovalQuestion('delete_all', undefined)).toBe('Approve delete_all?')
  })

  it('still asks when the input cannot be rendered, rather than failing the gate', () => {
    const circular: Record<string, unknown> = { name: 'loop' }
    circular.self = circular
    expect(renderApprovalQuestion('issue_refund', circular)).toBe('Approve issue_refund?')
    expect(renderApprovalQuestion('issue_refund', () => undefined)).toBe('Approve issue_refund?')
  })
})

describe('describeAnswer', () => {
  it('tells the model not to proceed when there is no answer', () => {
    const text = describeAnswer('confirm', ask({ answered: false, status: 'expired', approved: false }))
    expect(text).toContain('NOT approved')
  })

  it('reports the value for select and input', () => {
    expect(describeAnswer('select', ask({ type: 'select', value: 'B' }))).toContain('B')
  })
})

describe('isAffirmative', () => {
  it('is fail-closed on anything that is not a yes', () => {
    expect(isAffirmative('yes')).toBe(true)
    expect(isAffirmative('Approve')).toBe(true)
    expect(isAffirmative('no')).toBe(false)
    expect(isAffirmative(null)).toBe(false)
    expect(isAffirmative(undefined)).toBe(false)
  })
})

describe('resolvePusharyCallback', () => {
  const body = JSON.stringify({
    event: 'decision.answered',
    correlationId: 'd1',
    answer: 'yes',
    value: 'yes',
    answeredAt: '2026-08-17T00:00:00.000Z',
  })

  it('parses a correctly signed callback', () => {
    expect(resolvePusharyCallback(body, sign(body), SECRET)).toMatchObject({
      correlationId: 'd1',
      answer: 'yes',
      approved: true,
    })
  })

  it('rejects a forged signature', () => {
    expect(resolvePusharyCallback(body, 'deadbeef', SECRET)).toBeNull()
  })
})

describe('operation identity', () => {
  it('keeps independent asks separate and replays only an explicit operation key', async () => {
    const calls = installFetch([() => ask({})])
    const input = { externalId: 'u', node: 'refund', question: 'Approve?' }
    await kernel.askExternalUser(CONFIG, input)
    await kernel.askExternalUser(CONFIG, input)
    expect(calls[0].body?.idempotencyKey).not.toBe(calls[1].body?.idempotencyKey)
    await kernel.askExternalUser(CONFIG, { ...input, idempotencyKey: 'order-1' })
    await kernel.askExternalUser(CONFIG, { ...input, idempotencyKey: 'order-1' })
    expect(calls[2].body?.idempotencyKey).toBe('order-1')
    expect(calls[3].body?.idempotencyKey).toBe('order-1')
  })

  it('refuses a durable decision without operation identity before sending anything', async () => {
    const calls = installFetch([() => ask({})])
    await expect(kernel.createDurableDecision(CONFIG, { externalId: 'u', question: 'Approve?' }))
      .rejects.toThrow(/idempotencyKey/)
    expect(calls).toHaveLength(0)
  })
})
