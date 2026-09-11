/**
 * One protected action, end to end, against the sandbox. One command, no phone.
 *
 * A sandbox key opens a REAL decision — same durable row, same ledger entry, same
 * presentation — and a simulator answers it instead of a person. So all three
 * verdicts are reachable without enrolling a device or paying for a plan, and
 * what you prove here is what will run in production.
 *
 * Get a key while signed in to the dashboard:
 *   curl -X POST https://pushary.com/api/agent/sandbox -H "Cookie: $SESSION"
 *
 * Then:
 *   npm i @pushary/server
 *   PUSHARY_API_KEY=pk_x.sk_y npx tsx examples/protected-action.ts
 */
import { createPusharyServer } from '@pushary/server'
import { createAdapterKernel } from '@pushary/server/adapters'

const apiKey = process.env.PUSHARY_API_KEY
if (!apiKey) throw new Error('Set PUSHARY_API_KEY to a sandbox key.')

const BASE = process.env.PUSHARY_BASE_URL ?? 'https://pushary.com/api/v1/server'

const pushary = createPusharyServer({ apiKey, baseUrl: BASE })
const kernel = createAdapterKernel('this example')
const protect = kernel.protect({ apiKey, baseUrl: BASE, agentName: 'Refund bot', timeoutMs: 10_000 })

// Stands in for the side effect you are protecting. In your own code this is the
// Stripe call, the database write, the email.
const issueRefund = async (orderId: string, amountCents: number): Promise<string> => {
  console.log(`      -> refunding ${amountCents / 100} EUR on ${orderId}`)
  return `refund_${orderId}`
}

// Authorization rules are managed over REST; there is no SDK resource for them
// because the same server-side integrator who calls authorize() configures them
// once, not per request.
const addRule = async (body: unknown): Promise<void> => {
  const res = await fetch(`${BASE}/authorization-rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  })
  if (!res.ok && res.status !== 409) throw new Error(`rule: ${res.status} ${await res.text()}`)
}

const attempt = async (label: string, amountCents: number, callId: string): Promise<void> => {
  const outcome = await protect({
    action: 'refund.create',
    target: 'order_4471',
    externalId: 'customer_123',
    actor: 'agent:refund-bot',
    environment: 'sandbox',
    // The facts a rule may decide on. Passed by hand, because you know which of
    // this action's arguments matter and its raw input does not say.
    facts: { amount: amountCents, currency: 'EUR' },
    // Unique per attempt. Together with runId this is what makes a replay resolve
    // to the same decision instead of asking twice.
    callId,
    runId: 'run_demo',
    question: `Approve a ${amountCents / 100} EUR refund on order #4471?`,
    run: () => issueRefund('order_4471', amountCents),
  })
  console.log(`  ${label} ${outcome.ok ? `ran, returned ${outcome.result}` : `did not run: ${outcome.reason}`}`)
}

async function main() {
  console.log('\n1. No rule names refund.create, so a person decides.')
  console.log('   In the sandbox that person is the simulator, and it approves.')
  await attempt('escalated ->', 480, 'call_1')

  console.log('\n2. Add a rule that reads the amount.')
  await addRule({
    toolPattern: 'refund.create',
    effect: 'deny',
    conditions: [{ parameter: 'amount', operator: 'gte', value: 50_000 }],
  })
  console.log('   refund.create where amount >= 50000 -> deny')

  console.log('\n3. A large refund is now refused by policy. Nobody is paged, and')
  console.log('   the side effect never runs.')
  await attempt('denied    ->', 90_000, 'call_2')

  console.log('\n4. A small one still escalates, because no rule allows it outright.')
  const small = await pushary.evaluateAuthorization({
    toolName: 'refund.create',
    parameters: { amount: 480 },
  })
  console.log(`   verdict: ${small.verdict} — ${small.reason}`)

  console.log('\n5. Retry the FIRST refund, exactly as a framework would.')
  console.log('   The decision resolves to the same approval, and the permit it')
  console.log('   already spent refuses the second execution.')
  await attempt('retried   ->', 480, 'call_1')
  console.log()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
