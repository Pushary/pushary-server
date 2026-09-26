# @pushary/server

The decision layer for AI agents. Your agent asks, your user decides on their phone.

This is the server SDK for [Pushary](https://pushary.com). It also sends push notifications.

## What you need

- A Pushary Partner plan, from $99 a month, to ask your own users. [Start the trial](https://pushary.com/sign-up?from=agent&plan=partner).
- An API key from [Partner onboarding](https://pushary.com/onboarding/partner), set as `PUSHARY_API_KEY`.
- Your users install the free Pushary app ([iPhone](https://apps.apple.com/us/app/pushary/id6785677563), [Android](https://play.google.com/store/apps/details?id=com.pushary.app)). They never sign up or pay.

## Installation

```bash
npm install @pushary/server
# or
yarn add @pushary/server
# or
pnpm add @pushary/server
# or
bun add @pushary/server
```

## Quick Start

```typescript
import { createPusharyServer } from '@pushary/server'

const pushary = createPusharyServer({ apiKey: process.env.PUSHARY_API_KEY })

const { universalLink } = await pushary.enroll('user-123')
// Once per user: show universalLink as a button or QR code.

const { approved } = await pushary.decisions.ask({
  externalId: 'user-123',
  question: 'Issue a $50 refund?',
  type: 'confirm', // confirm | select | input
})
if (approved) await issueRefund()
```

That is the whole integration: connect a user's phone once, then ask them whenever
your agent needs a yes. `ask()` creates a fresh decision per call and waits until the
person answers or the deadline passes (55 seconds by default). `approved` is true only
when the person said yes, so a declined, expired or unanswered decision blocks the
action. For longer waits, see [Decisions (lower-level)](#decisions-lower-level).

## API Key

The server SDK requires your full API key (`pk_xxx.sk_xxx`) which includes the secret portion. 

**Never expose this in client-side code.**

Get your API key by following [Get your API key](https://pushary.com/docs/agents/api-key).

## Push notifications quick start

```typescript
import { createPusharyServer } from '@pushary/server'

const pushary = createPusharyServer({
  apiKey: process.env.PUSHARY_API_KEY,
})

await pushary.notifications.send({
  title: 'Hello!',
  body: 'Your order has shipped',
  subscriberIds: ['sub_123'],
})
```

## Resources

### Subscribers

```typescript
const { data, hasMore, nextCursor } = await pushary.subscribers.list({
  limit: 100,
  status: 'active',
})

const subscriber = await pushary.subscribers.get('sub_123')

await pushary.subscribers.update('sub_123', {
  tags: ['vip', 'newsletter'],
  externalId: 'user-456',
})

await pushary.subscribers.delete('sub_123')

const count = await pushary.subscribers.count()
```

### Campaigns

```typescript
const { data } = await pushary.campaigns.list()

const campaign = await pushary.campaigns.create({
  name: 'Welcome Campaign',
  title: 'Welcome!',
  body: 'Thanks for subscribing',
  actionUrl: 'https://example.com/welcome',
})

await pushary.campaigns.send(campaign.id)

await pushary.campaigns.pause(campaign.id)
await pushary.campaigns.resume(campaign.id)

const stats = await pushary.campaigns.stats(campaign.id)
```

### Templates

```typescript
const { data } = await pushary.templates.list()

const template = await pushary.templates.create({
  name: 'Order Update',
  title: 'Order {{orderId}} Update',
  body: 'Your order status: {{status}}',
})

await pushary.templates.update(template.id, {
  body: 'Your order {{orderId}} is now {{status}}',
})

await pushary.templates.delete(template.id)
```

### Notifications (Direct Send)

```typescript
await pushary.notifications.send({
  title: 'Flash Sale!',
  body: '50% off everything',
  url: 'https://example.com/sale',
  subscriberIds: ['sub_123', 'sub_456'],
})

await pushary.notifications.send({
  title: 'New Message',
  body: 'You have a new message',
  externalIds: ['user-123'],
})

await pushary.notifications.send({
  title: 'VIP Exclusive',
  body: 'Special offer just for you',
  tags: ['vip'],
})
```

### Decisions (lower-level)

For long waits or your own resume logic, use `create` + a webhook or `get`, and
`verifyWebhookSignature`. Full guide: [Embed human approval](https://pushary.com/docs/agents/embed).

```typescript
import { verifyWebhookSignature } from '@pushary/server'

// Create (async by default). Always pass an idempotencyKey.
const decision = await pushary.decisions.create({
  externalId: 'user-123',
  question: 'Publish this to your public profile?',
  type: 'confirm',                      // confirm | select | input
  callbackUrl: 'https://yourapp.com/webhooks/pushary',
  idempotencyKey: 'run-abc-step-3',
})

// Resume from the webhook, or poll durably.
const state = await pushary.decisions.get(decision.decisionId, { wait: 30 })
if (state.answered) console.log(state.value)

// Relay an answer collected in your own app.
await pushary.decisions.answer(decision.decisionId, 'yes')

// Verify a webhook callback (fetch the secret once and cache it).
const { webhookSecret } = await pushary.decisions.getWebhookSecret()
const ok = verifyWebhookSignature(rawBody, signatureHeader, webhookSecret)
```

### List decisions

`decisions.list()` returns customer decisions newest first, within your plan's retention window. Bound keys only see their own customer. Sandbox tests and Pushary's internal preview/onboarding recipients are excluded. Status is `pending`, `answered`, `expired`, or `cancelled`.

```ts
const page = await pushary.decisions.list({ externalId: 'user-123', limit: 50 })
const next = page.nextCursor
  ? await pushary.decisions.list({ externalId: 'user-123', limit: 50, cursor: page.nextCursor })
  : null
```

Pass `nextCursor` unchanged with the same filters. It is opaque; malformed cursors return HTTP 400.

### Helpers

Four exports that the flows above rely on. Signatures are given because guessing
them is easy to get wrong: `deterministicKey` takes an **array**, and `isApproved`
reads a decision's `status`/`value`, not an `answer` field.

```typescript
import {
  deterministicKey,
  isApproved,
  parseDecisionCallback,
  SIGNATURE_HEADER,
} from '@pushary/server'

// deterministicKey(parts: readonly string[]): string
// A stable idempotency key from the parts that identify one logical step. Same
// parts in, same key out, so a retried run reuses its decision instead of asking
// the human twice.
const idempotencyKey = deterministicKey(['run-abc', 'step-3', 'user-123'])

// isApproved(decision: { status, type?, value }): boolean
// For confirm: true only for an affirmative answer. For select/input: true
// means answered, not permission to act. Check the actual value for those types.
isApproved({ status: 'answered', type: 'confirm', value: 'yes' })  // true
isApproved({ status: 'answered', type: 'confirm', value: 'no' })   // false
isApproved({ status: 'pending', type: 'confirm', value: null })    // false

// SIGNATURE_HEADER: 'x-pushary-signature', the header carrying the signature.
// parseDecisionCallback(rawBody: string): DecisionCallback | null
//   Takes the RAW body string, not a parsed object, and returns null if the
//   payload is not a well-formed callback. Verify the signature first.
app.post('/webhooks/pushary', async (req, res) => {
  const rawBody = req.rawBody.toString('utf8')
  if (!verifyWebhookSignature(rawBody, req.header(SIGNATURE_HEADER), webhookSecret)) {
    return res.sendStatus(401)
  }

  const callback = parseDecisionCallback(rawBody)
  if (!callback) return res.sendStatus(400)

  // A callback carries { correlationId, answer, value, answeredAt }. It has no
  // `status` field, so it is not an isApproved() argument. Reaching this point
  // already means the decision was answered, so judge the value directly, or
  // re-read the decision if you want isApproved to do it for you.
  if (callback.value === 'yes') await issueRefund()

  res.sendStatus(200)
})
```

## Writing a framework adapter: `@pushary/server/adapters`

Customers answer in the native Pushary app. Confirm, select, and input questions keep their existing meanings; a choice or typed answer is data, not permission to execute a protected tool. Enroll the customer from trusted application identity before asking. Legacy web links remain an optional delivery path.

Both blocking and durable adapter calls accept `DecisionSubject` fields, including `parameters` and `presentation`, plus expiration, reachability, and placeholder settings. Durable calls require an operation-specific idempotency key; persist the returned decision ID alongside the framework's suspended run. Verify callbacks and read the authoritative decision before resuming that run.

For an explicit human gate, set `policy: false`. The gate keeps the full review subject and binds its decision key to the run, call, recipient, question, and complete JSON arguments. `decisionFingerprint(value)` exposes the same stable JSON fingerprint for deferred bindings. It rejects cycles, nonfinite numbers, and non-JSON objects instead of silently dropping action details.

**Upgrade handling:** version 2.1 changes human gate keys. Finish already-started operations on the SDK version that created them, or migrate their persisted bindings explicitly. Do not replay previously executed operations through the new key scheme. A fingerprint identifies the proposed action; the application's execution record and framework persistence still own recovery after an uncertain tool execution.

Every official Pushary adapter (`@pushary/eve`, `@pushary/ai-sdk`,
`@pushary/langgraph`, `@pushary/mastra`, `@pushary/openai-agents`,
`@pushary/claude-agent-sdk`) is a thin binding
over one shared kernel, and that kernel is public. If you run an in-house harness, or
a framework we have not shipped for, this is the same surface they are built on.

```typescript
import { createAdapterKernel, renderApprovalQuestion } from '@pushary/server/adapters'

const kernel = createAdapterKernel('the Acme helpers')

// blocking ask; idempotency and the fail-closed result are already handled
export const askHuman = kernel.askExternalUser

// durable create, for a framework that parks its own run and resumes on a webhook
export const openDecision = kernel.createDurableDecision

// an enforced gate: build it once, call it per tool call
const gate = kernel.createGate({ apiKey: process.env.PUSHARY_API_KEY! })

export const approve = async (toolName: string, callId: string, input: unknown) => {
  const decision = await gate({
    toolName,
    callId,
    sessionId: currentRunId,
    question: renderApprovalQuestion(toolName, input),
    externalId: kernel.requireExternalId(currentUserId),
    // optional: lets a rule decide on the arguments, not only the action name
    input,
  })
  return decision // { approved: true } | { approved: false, reason }
}
```

The gate asks your policy before it asks a person. A rule that names the action
resolves it with nobody paged: `allow` returns approved and opens no decision, `deny`
returns a reason the model reads, and anything no rule names still asks. A site with
no rules behaves exactly as before, because a rule has to name the action and `*` is
never selected. Pass `policy: false` to restore the always-ask gate.

The label passed to `createAdapterKernel` is what appears in the error when a key or
an end-user is missing, so it names your helpers rather than ours.

### One protected action: `protect()`

`createGate` answers a yes/no. `protect()` is that plus running the thing, so the
authorize, escalate and execute steps stop being three pieces of plumbing in your
business code.

```typescript
const protect = kernel.protect({ apiKey: process.env.PUSHARY_API_KEY! })

const outcome = await protect({
  action: 'refund.create',
  target: 'order_4471',
  externalId: customer.id,
  facts: { amount: 4800, currency: 'EUR' },   // what a rule may decide on
  callId: attemptId,
  runId: sessionId,
  run: () => stripe.refunds.create({ charge, amount: 4800 }),
})

outcome.ok ? outcome.result : outcome.reason
```

A rule that names `refund.create` resolves it with nobody paged. Anything no rule
names asks a person. `run` is called only after the action is authorized, and an
error it throws is not caught: reporting it as `ok: false` would be
indistinguishable from a refusal.

`protect()` is **at most once**. The decision is idempotent: a replay of the same
`runId` + `callId` + action lands on the same approval instead of asking twice: and
the approval is then spent against a durable permit before `run` is called. A retry, a
concurrent worker and a resumed run all reach the same permit and exactly one of them
proceeds; the rest come back `ok: false` with a reason worded to stop the model rather
than invite another attempt.

The permit is bound to the exact subject that was authorized: the action, its target,
the actor, the environment, the end-user and every fact you sent: so changing the
amount between the approval and the execution leaves you with no permit for the action
you now want to run. `protect()` then records `succeeded` or `failed` against it; a
process that dies mid-action leaves the permit unresolved, which is visible and
reconcilable, rather than an action that ran twice, which is not.

The two calls underneath are public if you own your own execution path:
`pushary.consumeAuthorization(binding)` and `pushary.recordExecution({ permitId,
outcome, summary })`. A refusal carries a `refusal` you can branch on:
`not_authorized`, `action_mismatch`, `expired` or `already_consumed`.

Python is the same two-step surface: `protect = kernel.create_protect()`, then
`protect(action, run, external_id=..., call_id=..., run_id=...)`. Building it once is
what makes a missing key raise where the protector is defined rather than on the
first action.

A runnable end-to-end version, against the sandbox and with no phone involved, is
in [`examples/protected-action.ts`](./examples/protected-action.ts).


Also exported: `describeAnswer` (turn an outcome into an instruction the model cannot
misread), `resolvePusharyCallback` (verify and parse a webhook in one call),
`idempotencyKeyFor`, and `isAffirmative`.

Python has the same surface as `pushary.adapters`:

```python
from pushary.adapters import AdapterKernel, render_approval_question

kernel = AdapterKernel("the Acme helpers")
ask_human = kernel.ask_human
gate = kernel.create_gate()
```

`create_gate(policy=False)` is the same escape hatch. Neither language evaluates a
rule locally; the verdict is the server's, so the two cannot disagree about what a
policy means.

Both give you what the shipped adapters have: idempotency keyed on the call so a
replay never asks twice, a denial reason the model can read, and silence treated as a
no.

## Handling errors

Every non-2xx response throws a `PusharyApiError`. It extends `Error`, so existing
`catch (e) { e.message }` code is unaffected, and it carries the status so you can
tell "stop and re-authenticate" from "back off and retry" without matching on
message text.

```typescript
import { PusharyApiError } from '@pushary/server'

try {
  await pushary.notifications.send({ title: 'Deploy finished' })
} catch (err) {
  if (err instanceof PusharyApiError) {
    if (err.isAuthError) throw err          // 401/403: key is bad or revoked, do not retry
    if (err.isRateLimited) return backOff() // 429
    if (err.isServerError) return retry()   // 5xx
    console.error(err.status, err.code, err.message) // 4xx: your request, fix the call
  }
  throw err
}
```

`status`, `statusText`, `code` and `body` are all readable; `code` and `body` are
present only when the API sent them.

## TypeScript

Full TypeScript support with exported types:

```typescript
import {
  createPusharyServer,
  type Subscriber,
  type Campaign,
  type Template,
  type SendNotification,
} from '@pushary/server'
```

## Security

- API keys are site-scoped (each site has isolated VAPID keys)
- Keys should be stored in environment variables
- Rotate keys via dashboard if compromised

## License

MIT. See `LICENSE`.

## Retries and deadlines

For retries of one business operation, pass `idempotencyKey: deterministicKey([runId, stepId, userId])`. Independent asks get fresh keys, even with identical questions. Shared adapter durable creates require this key; missing keys fail before a request is sent. Keep a run ID unique per operation and stable across its retries.

A positive `timeoutMs` covers creation and polling. `timeoutMs: 0` retains create-only behavior. A timeout during creation throws; retry with the same explicit key to recover the decision. A timeout during polling returns the known pending decision ID for later `get()` or a webhook. `signal` cancels the local wait and throws; it does not cancel the remote decision. Other HTTP calls use `requestTimeoutMs` (65 seconds by default).

### Upgrading to 2.0

Upgrade the framework adapter alongside this SDK. Durable helpers now require an explicit `idempotencyKey` tied to the run and step. The 0.3 LangGraph, Mastra and OpenAI adapters support this contract. Earlier adapters must keep the 1.x SDK until migrated. Independent blocking calls no longer deduplicate by question text.
