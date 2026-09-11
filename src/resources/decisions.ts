import type {
  RequestFn,
  CreateDecision,
  DecisionResult,
  Decision,
  DecisionAnswerResult,
  CancelDecisionResult,
  WebhookSecret,
  AskDecision,
  AskResult,
  DecisionType,
  DecisionStatus,
} from '../types'
import { randomUUID } from 'crypto'
import { isApproved } from '../util'

// A single long-poll window. The server clamps GET ?wait to 55s, so ask() loops
// windows of this size until the decision resolves or the caller deadline passes.
const POLL_WINDOW_SECONDS = 50
const DEFAULT_ASK_TIMEOUT_MS = 55_000

// Human-in-the-loop decisions: ask a specific end-user to approve, then resume
// on their answer via webhook or poll. See the Partner integration guide.
export interface DecisionsResource {
  // Create a decision. Defaults to async (returns immediately with a decisionId);
  // pass wait:true to block up to ~55s for a fast answer. Always pass
  // idempotencyKey so a retried call does not ask the same human twice.
  readonly create: (data: CreateDecision) => Promise<DecisionResult>
  // Poll for the outcome. opts.wait long-polls up to N seconds. Reads durably, so
  // it still resolves after the live window closes.
  readonly get: (id: string, opts?: { readonly wait?: number }) => Promise<Decision>
  // Create a decision and block until the human answers or the deadline passes,
  // polling durably (so a crashed/resumed process still gets the answer). Returns
  // a fail-closed `approved` flag. Default deadline 55s (serverless-safe); the
  // decision stays answerable for its full TTL, so an {answered:false} return is
  // resolvable later via get() or a callbackUrl. This is the one call most agents
  // need. Each call reaches the human: without an idempotencyKey a fresh unique
  // key is generated per call, so two asks with the same text never collapse into
  // one silent auto-approval. Pass your own stable idempotencyKey (tied to your
  // operation id) only when you WANT a retried call to dedupe.
  readonly ask: (data: AskDecision) => Promise<AskResult>
  // Relay the end-user's answer from your own authenticated app (delegated auth).
  readonly answer: (id: string, answer: string) => Promise<DecisionAnswerResult>
  readonly cancel: (id: string) => Promise<CancelDecisionResult>
  // Your webhook signing secret (created on first call). Verify callbacks with
  // verifyWebhookSignature(rawBody, header, secret).
  readonly getWebhookSecret: () => Promise<WebhookSecret>
  readonly rotateWebhookSecret: () => Promise<WebhookSecret>
}

export const createDecisionsResource = (request: RequestFn): DecisionsResource => {
  const ask = async (data: AskDecision): Promise<AskResult> => {
    // Idempotency is caller intent, never inferred from content: two asks with the
    // same text are usually two distinct decisions, so a content hash would make
    // the second silently replay the first answer (auto-approving a second refund,
    // or blocking a re-ask for the server's whole idempotency window). Default to a
    // unique key per call so every ask reaches the human; callers wanting retry
    // dedup pass their own stable key tied to their operation.
    const idempotencyKey = data.idempotencyKey ?? randomUUID()

    const timeoutMs = Math.max(0, data.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS)
    // Zero retains the create-only API. Positive budgets include creation and polling.
    const deadline = Date.now() + timeoutMs
    const controller = new AbortController()
    const abort = () => controller.abort(data.signal?.reason)
    if (data.signal?.aborted) abort()
    else data.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(new DOMException('Pushary ask timed out', 'TimeoutError')), timeoutMs || 65_000)
    try {
      const created = await request<DecisionResult>('POST', '/decisions', {
        question: data.question,
        type: data.type,
        options: data.options,
        externalId: data.externalId,
        email: data.email,
        agentName: data.agentName,
        context: data.context,
        placeholder: data.placeholder,
        toolName: data.toolName,
        toolTarget: data.toolTarget,
        actor: data.actor,
        environment: data.environment,
        parameters: data.parameters,
        // Its changes name parameters rather than carrying values, so what the
        // person sees is read from the same numbers a rule compares.
        presentation: data.presentation,
        approvalUrl: data.approvalUrl,
        expiresInSeconds: data.expiresInSeconds,
        poweredBy: data.poweredBy,
        callbackUrl: data.callbackUrl,
        requireReachable: data.requireReachable,
        // Read only by a key issued on your workspace's sandbox site, where the
        // simulator answers instead of a person. Ignored in production.
        sandboxOutcome: data.sandboxOutcome,
        idempotencyKey,
        wait: false,
      }, { signal: controller.signal })

      const type: DecisionType = created.type ?? data.type ?? 'confirm'
      let status: DecisionStatus = created.status
      let answered = created.answered
      let value: string | null = created.value ?? null

      while (status === 'pending' && Date.now() < deadline) {
        const waitSeconds = Math.max(
          1,
          Math.min(POLL_WINDOW_SECONDS, Math.ceil((deadline - Date.now()) / 1000)),
        )
        try {
          const polled = await request<Decision>('GET', `/decisions/${created.decisionId}`, {
            wait: waitSeconds,
          }, { signal: controller.signal })
          status = polled.status
          answered = polled.answered
          value = polled.value
        } catch (error) {
          if (controller.signal.aborted && !data.signal?.aborted) break
          throw error
        }
      }

      return {
        decisionId: created.decisionId,
        status,
        answered,
        value,
        type,
        approved: isApproved({ status, type, value }),
        // Surfaced from the create response so a caller can tell an unanswered
        // decision that reached nobody (reachable:false) apart from a real decline.
        reachable: created.reachable,
        reachableChannels: created.reachableChannels,
        deviceCount: created.deviceCount,
      }
    } finally {
      clearTimeout(timer)
      data.signal?.removeEventListener('abort', abort)
    }
  }

  return Object.freeze({
    create: (data: CreateDecision) => request<DecisionResult>('POST', '/decisions', data),
    get: (id: string, opts?: { readonly wait?: number }) =>
      request<Decision>('GET', `/decisions/${id}`, opts?.wait ? { wait: opts.wait } : undefined),
    ask,
    answer: (id: string, answer: string) =>
      request<DecisionAnswerResult>('POST', `/decisions/${id}`, { answer }),
    cancel: (id: string) => request<CancelDecisionResult>('DELETE', `/decisions/${id}`),
    getWebhookSecret: () => request<WebhookSecret>('GET', '/webhook-secret'),
    rotateWebhookSecret: () => request<WebhookSecret>('POST', '/webhook-secret'),
  })
}
