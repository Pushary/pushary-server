// The shared kernel behind every Pushary framework adapter. Published as
// `@pushary/server/adapters` so a new adapter is a thin binding — map the
// framework's context onto these shapes, map the result back — instead of another
// copy of the same ~150 lines. Nothing here imports a framework.

import { randomUUID } from 'node:crypto'
import { createPusharyServer, type PusharyServer } from './client'
import { decisionFingerprint, isApproved } from './util'
import { parseDecisionCallback, verifyWebhookSignature } from './webhook'
import type {
  AskResult,
  AuthorizationBinding,
  AuthorizationEvaluation,
  AuthorizationVerdict,
  ConsumeAuthorizationResult,
  DecisionParameters,
  DecisionSubject,
  DecisionType,
  EnrollResult,
  ExecutionOutcome,
} from './types'

/** Config every adapter accepts, whatever framework it binds. */
export interface PusharyAdapterConfig {
  /** Pushary API key (pk_xxx.sk_xxx). Defaults to `process.env.PUSHARY_API_KEY`. */
  readonly apiKey?: string
  /** Shown on the approval so the human knows which agent is asking. */
  readonly agentName?: string
  /** How long a blocking ask waits before returning (default 55s, serverless-safe). */
  readonly timeoutMs?: number
  /** Override the API base URL (tests / self-host). */
  readonly baseUrl?: string
}

/** One ask, as an adapter hands it to the kernel. */
export interface AskHumanInput extends DecisionSubject {
  /** Stable business operation ID for retries; required when parking a durable workflow. */
  readonly idempotencyKey?: string
  readonly question: string
  /** Your own stable id for the end-user who decides. */
  readonly externalId: string
  /** Stable node/step/tool name, used to build a re-run-safe idempotency key. */
  readonly node?: string
  readonly type?: DecisionType
  readonly options?: readonly string[]
  readonly context?: string
  /** Present on the durable path; Pushary POSTs the answer here. */
  readonly callbackUrl?: string
  readonly expiresInSeconds?: number
  readonly requireReachable?: boolean
  readonly placeholder?: string
}

/** A decision opened durably, before the framework parks its run. */
export interface CreatedDecision {
  readonly decisionId: string
  readonly correlationId: string
  readonly status: string
  readonly reachable?: boolean
  readonly reachableChannels?: number
  readonly deviceCount?: number
}

/** A verified, parsed answer callback, keyed by `correlationId`. */
export interface PusharyCallback {
  readonly correlationId: string
  readonly answer: string
  readonly value: string
  readonly approved: boolean
  readonly context?: string
  readonly answeredAt: string
}

/**
 * What the human is shown when the caller names no question.
 *
 * The action and its target, not a rendering of the facts: a protected action is
 * written by hand, so its name is already business language ("refund.create
 * order_4471") in a way a tool's raw input never is.
 */
export const defaultProtectQuestion = (action: string, target?: string): string =>
  `Approve ${action}${target ? ` ${target}` : ''}?`

/**
 * Only an explicit operation key may replay an approval. Independent asks get
 * fresh keys even when their question and recipient are identical.
 */
export const idempotencyKeyFor = (input: AskHumanInput): string =>
  input.idempotencyKey ?? randomUUID()

const decisionSubject = (input: AskHumanInput) => ({
  toolTarget: input.toolTarget,
  actor: input.actor,
  environment: input.environment,
  parameters: input.parameters,
  presentation: input.presentation,
  approvalUrl: input.approvalUrl,
  expiresInSeconds: input.expiresInSeconds,
  requireReachable: input.requireReachable,
  placeholder: input.placeholder,
  callbackUrl: input.callbackUrl,
})

/** Fail-closed yes/no check for a confirm answer. */
export const isAffirmative = (answer: string | null | undefined): boolean =>
  isApproved({ status: 'answered', type: 'confirm', value: answer ?? null })

/** Turn a decision outcome into an unambiguous instruction for the model. */
export const describeAnswer = (type: DecisionType, result: AskResult): string => {
  if (!result.answered) {
    return `No answer (status: ${result.status}). Treat this as NOT approved and do not proceed.`
  }
  if (type === 'confirm') {
    return result.approved
      ? 'The human approved. You may proceed.'
      : 'The human declined. Do not proceed.'
  }
  return `The human answered: ${result.value ?? ''}`
}

/**
 * Verify a callback signature and parse it, or return null. The `answer` is what
 * you feed back into the framework's resume seam.
 */
export const resolvePusharyCallback = (
  rawBody: string,
  signature: string | null | undefined,
  secret: string,
): PusharyCallback | null => {
  if (!verifyWebhookSignature(rawBody, signature, secret)) return null
  const callback = parseDecisionCallback(rawBody)
  if (!callback) return null
  return {
    correlationId: callback.correlationId,
    answer: callback.answer,
    value: callback.value,
    approved: isAffirmative(callback.answer),
    context: callback.context,
    answeredAt: callback.answeredAt,
  }
}

/**
 * Connection-level options for a request-time approval gate. Everything that
 * varies per tool call lives on {@link ApprovalAsk} instead, so a gate holds one
 * client and no per-call state.
 */
export interface PusharyGateConfig {
  /** Pushary API key. Defaults to `process.env.PUSHARY_API_KEY`. */
  readonly apiKey?: string
  /** Shown on the approval so the human knows which agent is asking. */
  readonly agentName?: string
  /** How long the decision stays answerable. */
  readonly expiresInSeconds?: number
  /** How long to block waiting for an answer before failing closed. */
  readonly timeoutMs?: number
  /**
   * Refuse to open a decision nobody can receive, so an end-user with no connected
   * device is denied at request time instead of silently expiring.
   */
  readonly requireReachable?: boolean
  /**
   * Ask the site's policy before asking a person (default true). A rule that names
   * the action resolves it without paging anyone; everything else still asks.
   *
   * Set false to restore the always-ask gate: a site whose rules were written for
   * its own coding agents, and which happens to name a tool this gate also sits
   * on, would otherwise start resolving that tool automatically.
   */
  readonly policy?: boolean
  /** Override the API base URL (tests / self-host). */
  readonly baseUrl?: string
}

/**
 * One gated tool call, resolved down to what Pushary needs. The adapter owns the
 * mapping from its framework's context, so per-call resolvers stay typed against
 * the framework's own shapes rather than a lowest common denominator.
 */
export interface ApprovalAsk {
  /** The tool the model wants to run. */
  readonly toolName: string
  /** Unique per tool call. Keys the decision together with `sessionId`. */
  readonly callId: string
  /** Stable per run, session, or thread. */
  readonly sessionId: string
  /** What the human is shown. */
  readonly question: string
  /** The enrolled end-user who decides. */
  readonly externalId: string
  /** What the tool acts on, e.g. an order id. Narrows which rule governs. */
  readonly toolTarget?: string
  /** Whose authority the action claims, e.g. `user:u_44`. Not the approver. */
  readonly actor?: string
  /** Which deployment the action runs against, e.g. `production`. */
  readonly environment?: string
  /**
   * The tool's raw input. Bounded scalars are derived from it so a rule can decide
   * on the arguments and not only on the name; anything the bounds cannot carry
   * sends nothing, which escalates. Already rendered into the default question, so
   * passing it exposes nothing new.
   */
  readonly input?: unknown
  /** Explicit facts for policy, used instead of deriving them from `input`. */
  readonly parameters?: DecisionParameters
  readonly presentation?: DecisionSubject['presentation']
  readonly context?: string
}

/**
 * What a gate answers. Denials always carry a reason the model can read.
 *
 * An approval also carries the binding: which authorization settled it and the
 * exact subject it was recorded against. Carried rather than rebuilt, because
 * only the gate knows what it actually sent — the ask records the full subject
 * only when the evaluation succeeded — and a caller that rebuilds it would send
 * a subject the record does not hold and be refused for its own approval.
 * Absent only from a server too old to name the authorization.
 */
export type ApprovalDecision =
  | { readonly approved: true; readonly authorization?: AuthorizationBinding }
  | { readonly approved: false; readonly reason: string }

/**
 * A request-time gate: ask the site's policy, ask a person when policy defers,
 * fail closed either way.
 */
export type ApprovalGate = (ask: ApprovalAsk) => Promise<ApprovalDecision>

const MAX_INPUT_CHARS = 300

export const DENIED_UNANSWERED =
  'No answer from the approver, so this was denied. Do not retry the same action.'
export const DENIED_REFUSED = 'The approver denied this action.'
export const DENIED_BY_POLICY = 'Denied by policy. Do not retry the same action.'

export const UNBOUND_APPROVAL =
  'This was approved, but the approval could not be bound to a single execution, so it was not run. Do not retry the same action.'

export const UNCONFIRMED_PERMIT =
  'This was approved, but it could not be confirmed as still unspent, so it was not run. Ask again rather than retrying this one.'

const REFUSED_REPLAY =
  'This authorization was already used. The action has run once and must not run again.'

/**
 * A refused permit, as the model reads it.
 *
 * `already_consumed` is worded to stop the caller rather than to invite a retry,
 * because a retry is the failure: something already ran this action once, and
 * the agent reading this cannot see that from its own state.
 */
export const refusedPermit = (
  refused: Extract<ConsumeAuthorizationResult, { consumed: false }>,
): string => (refused.refusal === 'already_consumed' ? REFUSED_REPLAY : `${refused.reason} Do not retry the same action.`)

/**
 * A policy denial, as the model reads it. The server already words the reason
 * ("Denied by policy rule refund.create."); the retry instruction is added here so
 * every denial this gate returns ends the same way, whoever settled it.
 */
export const deniedByPolicy = (evaluation: AuthorizationEvaluation): string =>
  evaluation.reason ? `${evaluation.reason} Do not retry the same action.` : DENIED_BY_POLICY

const PARAMETERS_MAX_KEYS = 32
const PARAMETER_KEY_MAX_LENGTH = 64
const PARAMETER_VALUE_MAX_LENGTH = 200

/**
 * Bounded facts for policy, derived from a tool's own input.
 *
 * All or nothing, deliberately. The bounds mirror what the API accepts, so a
 * partial object is always representable — and that is exactly the danger: a rule
 * reading `amount >= 500` stops denying the moment `amount` goes missing, so
 * dropping one entry can only ever move a verdict toward allow. Sending nothing
 * instead leaves the rule's parameter absent, which escalates to a person.
 *
 * The same bounds also mean this never turns a working tool call into a rejected
 * one: an input this cannot carry is simply not sent.
 */
export const deriveParameters = (input: unknown): DecisionParameters | undefined => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length === 0 || entries.length > PARAMETERS_MAX_KEYS) return undefined

  const parameters: Record<string, string | number | boolean> = {}
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > PARAMETER_KEY_MAX_LENGTH) return undefined
    if (typeof value === 'boolean') {
      parameters[key] = value
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) return undefined
      parameters[key] = value
    } else if (typeof value === 'string') {
      if (value.length > PARAMETER_VALUE_MAX_LENGTH) return undefined
      parameters[key] = value
    } else {
      return undefined
    }
  }
  return parameters
}

/**
 * The default question: the tool name plus a truncated view of its input, so the
 * human sees what they are approving without a wall of JSON on a lock screen.
 */
export const renderApprovalQuestion = (toolName: string, toolInput: unknown): string => {
  if (toolInput === undefined || toolInput === null) return `Approve ${toolName}?`
  const summary = summarise(toolInput)
  return summary === undefined ? `Approve ${toolName}?` : `Approve ${toolName}? ${summary}`
}

const summarise = (toolInput: unknown): string | undefined => {
  let rendered: string | undefined
  if (typeof toolInput === 'string') {
    rendered = toolInput
  } else {
    try {
      // Returns undefined for a function or a symbol, and throws on a cycle. Neither
      // is a reason to fail the tool call: a gate that cannot render its input still
      // has to ask, so fall back to the bare tool name.
      rendered = JSON.stringify(toolInput)
    } catch {
      return undefined
    }
  }
  if (rendered === undefined) return undefined
  return rendered.length > MAX_INPUT_CHARS ? `${rendered.slice(0, MAX_INPUT_CHARS)}...` : rendered
}


/**
 * One protected action: what it is, who it belongs to, and what it does.
 *
 * The shape a developer writes once instead of threading authorize, escalate and
 * run through their business code by hand. Everything above `run` is the same
 * subject `authorize()` and the decision both read, so the rule that governs the
 * action and the sentence the human sees describe the one thing.
 */
export interface ProtectedAction<TResult> {
  /** What is being done, e.g. `refund.create`. A rule has to name this. */
  readonly action: string
  /** What it is done to, e.g. an order id. Narrows which rule governs. */
  readonly target?: string
  /** The end-user this action belongs to, and who decides if policy defers. */
  readonly externalId: string
  /** Whose authority the action claims, e.g. `user:u_44`. Not the approver. */
  readonly actor?: string
  /** Which deployment it runs against, e.g. `production`. */
  readonly environment?: string
  /**
   * The bounded facts a rule may decide on, e.g. `{ amount: 4800 }`. Scalars
   * only. Passed as given rather than derived, because a protected action is
   * written by hand and the author knows which of its arguments matter.
   */
  readonly facts?: DecisionParameters
  /** Unique per attempt. Keys the decision together with `runId`. */
  readonly callId: string
  /** Stable per run, session or thread. */
  readonly runId: string
  /** What the human is shown. Defaults to the action and its target. */
  readonly question?: string
  /**
   * The side effect. Called only after the action is authorized, and never on a
   * denial or an unanswered escalation.
   */
  readonly run: () => Promise<TResult>
}

/**
 * What a protected action did.
 *
 * A discriminated union rather than a thrown error, because "policy said no" is
 * an ordinary outcome an agent has to be able to read and report, not an
 * exception. An error thrown by `run` itself is NOT caught: that is the caller's
 * failure, about their side effect, and swallowing it here would turn a failed
 * refund into a silent success.
 */
export type ProtectResult<TResult> =
  | { readonly ok: true; readonly result: TResult }
  | { readonly ok: false; readonly reason: string }

/** Protect one action. Build it once per configuration, call it per action. */
export type Protect = <TResult>(action: ProtectedAction<TResult>) => Promise<ProtectResult<TResult>>

/**
 * The calls an adapter makes, bound to one framework's name so a missing key or a
 * missing end-user says which helpers to configure. Build one per adapter module.
 */
export interface AdapterKernel {
  /** The underlying client, for anything the kernel does not cover. */
  readonly client: (config: PusharyAdapterConfig) => PusharyServer
  /**
   * Blocking ask: create a decision and poll durably until the human answers or
   * the deadline passes. A fresh key is used unless the caller supplies an operation-specific idempotencyKey.
   */
  readonly askExternalUser: (
    config: PusharyAdapterConfig,
    input: AskHumanInput,
  ) => Promise<AskResult>
  /**
   * Durable create: open a decision with a `callbackUrl` and return at once, for
   * a framework that parks its run and resumes on the webhook.
   */
  readonly createDurableDecision: (
    config: PusharyAdapterConfig,
    input: AskHumanInput,
  ) => Promise<CreatedDecision>
  /** Connect one end-user's phone (keyless). Show them the returned link. */
  readonly connect: (config: PusharyAdapterConfig, externalId: string) => Promise<EnrollResult>
  /**
   * Build a request-time approval gate. The client is created here, so a missing
   * key throws where the gate is defined rather than on the first tool call.
   */
  readonly createGate: (config: PusharyGateConfig) => ApprovalGate
  /**
   * Wrap one action so authorization, escalation and execution are one call.
   *
   * The whole of it is `createGate` plus "run it if the answer was yes", which is
   * the point: there is no second policy engine, no durable runtime and no new
   * abstraction under this. An adapter binds it by mapping its framework's
   * context onto ProtectedAction, exactly as it already does for the gate.
   *
   * At most once. The decision is idempotent — a replay of the same
   * `runId` + `callId` + action resolves to the same approval instead of asking
   * twice — and the approval is then spent against a durable permit before the
   * side effect runs. A retry, a concurrent worker and a resumed run all reach
   * the same permit, and exactly one of them proceeds; the rest are refused with
   * a reason that tells the model to stop rather than try again.
   *
   * `run` is called only after the permit is spent, never before, so the failure
   * mode of a crash mid-action is a permit with no receipt — which is visible —
   * rather than an action that runs twice, which is not recoverable.
   */
  readonly protect: (config: PusharyGateConfig) => Protect
  /**
   * The end-user to ask, or a clear error naming these helpers. Adapters call this
   * after applying their own resolver and the framework's own default.
   */
  readonly requireExternalId: (externalId: string | undefined) => string
}

/**
 * Build the kernel for one adapter.
 *
 * `helpersLabel` names the adapter in the missing-key error, so the message points
 * at the helpers the caller is actually using ("the LangGraph helpers").
 *
 * ```ts
 * const kernel = createAdapterKernel('the Acme helpers')
 * export const askHuman = kernel.askExternalUser
 * ```
 */
export const createAdapterKernel = (helpersLabel: string): AdapterKernel => {
  const requireApiKey = (apiKey: string | undefined): string => {
    const resolved = apiKey ?? process.env.PUSHARY_API_KEY
    if (!resolved) {
      throw new Error(`Pushary: set PUSHARY_API_KEY or pass { apiKey } to ${helpersLabel}.`)
    }
    return resolved
  }

  const client = (config: PusharyAdapterConfig): PusharyServer =>
    createPusharyServer({
      apiKey: requireApiKey(config.apiKey),
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    })

  const requireExternalId = (externalId: string | undefined): string => {
    if (!externalId?.trim()) {
      throw new Error(
        `Pushary: no end-user to ask. Pass { externalId } to ${helpersLabel}, or run ` +
          'user-scoped auth so the framework supplies one.',
      )
    }
    if (externalId.length > 256) throw new Error('Pushary: externalId must not exceed 256 characters.')
    return externalId
  }

  const createGate = (config: PusharyGateConfig): ApprovalGate => {
    const gateClient = createPusharyServer({
      apiKey: requireApiKey(config.apiKey),
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    })
    const usePolicy = config.policy ?? true

    /**
     * The verdict, or null if there is no usable one.
     *
     * Every failure is null rather than a throw. This route is entitled to the
     * Partner plan and is newer than the published adapters, so a caller who
     * cannot reach it — wrong plan, older deployment, a network blip — has to keep
     * working exactly as it did before policy existed, which is by asking a person.
     * Null is never allow, so the fail-safe direction is preserved.
     */
    const evaluate = async (
      ask: ApprovalAsk,
      facts: DecisionParameters | undefined,
    ): Promise<AuthorizationEvaluation | null> => {
      if (!usePolicy) return null
      try {
        return await gateClient.evaluateAuthorization({
          toolName: ask.toolName,
          toolTarget: ask.toolTarget,
          actor: ask.actor,
          environment: ask.environment,
          parameters: facts,
          externalId: ask.externalId,
          question: ask.question,
          ...(config.agentName ? { agentName: config.agentName } : {}),
        })
      } catch {
        return null
      }
    }

    return async (ask: ApprovalAsk): Promise<ApprovalDecision> => {
      if (!ask.callId?.trim()) throw new Error('Pushary: a stable tool call ID is required to resolve an approval.')
      requireExternalId(ask.externalId)
      // Derived once. The evaluation and the ask that may follow have to describe
      // the same action, and computing it twice is two chances for them not to.
      const facts = ask.parameters ?? deriveParameters(ask.input)
      const idempotencyKey = decisionFingerprint({ ...ask, parameters: facts })
      const evaluation = await evaluate(ask, facts)
      const includeSubject = evaluation !== null || !usePolicy
      if (evaluation?.verdict === 'allow') {
        return {
          approved: true,
          // Exactly the subject POST /authorize recorded, which is the whole of
          // what it was sent.
          ...(evaluation.authorizationId
            ? {
                authorization: {
                  authorizationId: evaluation.authorizationId,
                  toolName: ask.toolName,
                  toolTarget: ask.toolTarget,
                  actor: ask.actor,
                  environment: ask.environment,
                  externalId: ask.externalId,
                  parameters: facts,
                },
              }
            : {}),
        }
      }
      if (evaluation?.verdict === 'deny') {
        return { approved: false, reason: deniedByPolicy(evaluation) }
      }

      const result = await gateClient.decisions.ask({
        question: ask.question,
        type: 'confirm',
        externalId: ask.externalId,
        context: ask.context,
        ...(config.agentName ? { agentName: config.agentName } : {}),
        ...(config.expiresInSeconds ? { expiresInSeconds: config.expiresInSeconds } : {}),
        ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
        ...(config.requireReachable ? { requireReachable: config.requireReachable } : {}),
        // The gated tool, recorded on the decision. The gate already knows it
        // and keyed on it below; sending it is what lets the decision be grouped
        // and matched later instead of surviving only as prose in the question.
        toolName: ask.toolName,
        ...(includeSubject
          ? {
              presentation: ask.presentation,
              toolTarget: ask.toolTarget,
              actor: ask.actor,
              environment: ask.environment,
              parameters: facts,
            }
          : {}),
        // Stable across replays, so a re-run of this call resolves to the same
        // decision instead of asking twice.
        idempotencyKey,
      })

      if (result.approved) {
        return {
          approved: true,
          authorization: {
            authorizationId: result.decisionId,
            toolName: ask.toolName,
            externalId: ask.externalId,
            ...(includeSubject
              ? {
                  toolTarget: ask.toolTarget,
                  actor: ask.actor,
                  environment: ask.environment,
                  parameters: facts,
                }
              : {}),
          },
        }
      }
      return { approved: false, reason: result.answered ? DENIED_REFUSED : DENIED_UNANSWERED }
    }
  }

  const askExternalUser = (
    config: PusharyAdapterConfig,
    input: AskHumanInput,
  ): Promise<AskResult> =>
    client(config).decisions.ask({
      ...decisionSubject(input),
      question: input.question,
      type: input.type,
      options: input.options,
      externalId: requireExternalId(input.externalId),
      context: input.context,
      agentName: config.agentName,
      timeoutMs: config.timeoutMs,
      // The node/step name doubles as the action label. The default is not
      // sent: grouping every unnamed ask across every framework under one
      // bucket would mine into a suggestion to auto-approve "ask-human", which
      // spans unrelated questions.
      toolName: input.toolName ?? input.node,
      idempotencyKey: idempotencyKeyFor(input),
    })

  const createDurableDecision = async (
    config: PusharyAdapterConfig,
    input: AskHumanInput,
  ): Promise<CreatedDecision> => {
    if (!input.idempotencyKey?.trim()) {
      throw new Error('Pushary: durable decisions require an idempotencyKey tied to the run and step.')
    }
    const created = await client(config).decisions.create({
      ...decisionSubject(input),
      question: input.question,
      type: input.type,
      options: input.options,
      externalId: requireExternalId(input.externalId),
      context: input.context,
      callbackUrl: input.callbackUrl,
      agentName: config.agentName,
      toolName: input.toolName ?? input.node,
      idempotencyKey: idempotencyKeyFor(input),
      wait: false,
    })
    return {
      decisionId: created.decisionId,
      correlationId: created.decisionId,
      status: created.status,
      reachable: created.reachable,
      reachableChannels: created.reachableChannels,
      deviceCount: created.deviceCount,
    }
  }

  const connect = (config: PusharyAdapterConfig, externalId: string): Promise<EnrollResult> =>
    client(config).enroll(requireExternalId(externalId))

  const protect = (config: PusharyGateConfig): Protect => {
    // One gate per configuration, not per action: it holds the client, so
    // building it here means a missing key throws where protect() is defined
    // rather than on the first refund somebody tries to issue.
    const gate = createGate(config)
    const permitClient = client(config)

    // The receipt is evidence about an action that has already happened. Failing
    // the caller because the evidence could not be written would turn a
    // successful refund into an error and invite them to issue it again, which
    // is the exact outcome this whole path exists to prevent. A permit left
    // `running` is the honest record, and it is queryable.
    const report = async (permitId: string, outcome: ExecutionOutcome, summary?: string) => {
      try {
        await permitClient.recordExecution({ permitId, outcome, summary })
      } catch {
        // Deliberately swallowed. See above.
      }
    }

    return async <TResult>(action: ProtectedAction<TResult>): Promise<ProtectResult<TResult>> => {
      const decision = await gate({
        toolName: action.action,
        toolTarget: action.target,
        callId: action.callId,
        sessionId: action.runId,
        question: action.question ?? defaultProtectQuestion(action.action, action.target),
        externalId: action.externalId,
        actor: action.actor,
        environment: action.environment,
        parameters: action.facts,
      })

      if (!decision.approved) return { ok: false, reason: decision.reason }
      if (!decision.authorization) return { ok: false, reason: UNBOUND_APPROVAL }

      // Spent before the side effect, never after. A permit consumed after a
      // successful run would leave the window this exists to close: the crash
      // between the two would lose the record that it ran, and the retry would
      // run it again.
      let consumed
      try {
        consumed = await permitClient.consumeAuthorization(decision.authorization)
      } catch {
        // The action was approved and we could not confirm it is still ours to
        // run. Not running is the only safe answer; a duplicate refund cannot be
        // taken back and an unissued one can be asked for again.
        return { ok: false, reason: UNCONFIRMED_PERMIT }
      }
      if (!consumed.consumed) return { ok: false, reason: refusedPermit(consumed) }

      const permitId = consumed.permit.permitId
      let result: TResult
      try {
        result = await action.run()
      } catch (error) {
        // Recorded and rethrown, not swallowed. An error from the side effect is
        // the caller's, and reporting it as `ok: false` would be
        // indistinguishable from a refusal to an agent reading the result.
        await report(permitId, 'failed', error instanceof Error ? error.message : 'unknown error')
        throw error
      }
      await report(permitId, 'succeeded')
      return { ok: true, result }
    }
  }

  return Object.freeze({
    client,
    askExternalUser,
    createDurableDecision,
    connect,
    createGate,
    protect,
    requireExternalId,
  })
}

export { SIGNATURE_HEADER, verifyWebhookSignature, parseDecisionCallback } from './webhook'
export { decisionFingerprint, deterministicKey, isApproved } from './util'
export type {
  AskResult,
  AuthorizationEvaluation,
  AuthorizationVerdict,
  DecisionParameters,
  DecisionType,
  EnrollResult,
  PusharyServer,
}
