export interface PusharyConfig {
  readonly apiKey: string
  readonly baseUrl?: string
  /** HTTP request timeout, including response-body reading. Default 65 seconds. */
  readonly requestTimeoutMs?: number
}

export interface RequestContext {
  readonly timeoutMs?: number
  readonly baseUrl: string
  readonly headers: Readonly<Record<string, string>>
}

export interface ListParams {
  readonly limit?: number
  readonly cursor?: string
}

export interface PaginatedResponse<T> {
  readonly data: readonly T[]
  readonly nextCursor?: string
  readonly hasMore: boolean
}

export interface Subscriber {
  readonly id: string
  readonly siteId: string
  readonly endpoint: string
  readonly status: 'active' | 'unsubscribed' | 'expired' | 'bounced'
  readonly browser?: string
  readonly os?: string
  readonly deviceType?: string
  readonly country?: string
  readonly city?: string
  readonly timezone?: string
  readonly language?: string
  readonly tags?: readonly string[]
  readonly externalId?: string
  readonly createdAt: string
  readonly lastActiveAt?: string
}

export interface SubscriberListParams extends ListParams {
  readonly status?: 'active' | 'unsubscribed' | 'expired' | 'bounced'
  readonly tags?: readonly string[]
  readonly externalId?: string
}

export interface UpdateSubscriber {
  readonly tags?: readonly string[]
  readonly externalId?: string
  readonly customData?: Readonly<Record<string, unknown>>
}

export interface Campaign {
  readonly id: string
  readonly siteId: string
  readonly name: string
  readonly title: string
  readonly body: string
  readonly iconUrl?: string
  readonly imageUrl?: string
  readonly actionUrl?: string
  readonly status: 'draft' | 'scheduled' | 'sending' | 'active' | 'paused' | 'completed' | 'cancelled'
  readonly scheduledAt?: string
  readonly totalTargeted: number
  readonly totalSent: number
  readonly totalDelivered: number
  readonly totalClicked: number
  readonly createdAt: string
}

export interface CreateCampaign {
  readonly name: string
  readonly title: string
  readonly body: string
  readonly iconUrl?: string
  readonly imageUrl?: string
  readonly actionUrl?: string
  readonly scheduledAt?: string
  readonly segmentId?: string
  readonly tags?: readonly string[]
}

export interface UpdateCampaign {
  readonly name?: string
  readonly title?: string
  readonly body?: string
  readonly iconUrl?: string
  readonly imageUrl?: string
  readonly actionUrl?: string
  readonly scheduledAt?: string
  readonly status?: 'draft' | 'paused' | 'cancelled'
}

export interface Template {
  readonly id: string
  readonly siteId: string
  readonly name: string
  readonly title: string
  readonly body: string
  readonly iconUrl?: string
  readonly imageUrl?: string
  readonly actionUrl?: string
  readonly createdAt: string
}

export interface CreateTemplate {
  readonly name: string
  readonly title: string
  readonly body: string
  readonly iconUrl?: string
  readonly imageUrl?: string
  readonly actionUrl?: string
}

export interface UpdateTemplate {
  readonly name?: string
  readonly title?: string
  readonly body?: string
  readonly iconUrl?: string
  readonly imageUrl?: string
  readonly actionUrl?: string
}

export interface SendNotification {
  readonly title: string
  readonly body: string
  readonly iconUrl?: string
  readonly imageUrl?: string
  readonly url?: string
  readonly subscriberIds?: readonly string[]
  readonly externalIds?: readonly string[]
  readonly tags?: readonly string[]
  readonly data?: Readonly<Record<string, unknown>>
  readonly metadata?: Readonly<Record<string, unknown>>
  /** Stable across retries of one logical send. Maximum 200 characters. */
  readonly idempotencyKey?: string
}

export interface SendResult {
  readonly success: boolean
  readonly campaignId?: string
  readonly status?: 'queued'
  readonly queued?: number
  readonly duplicate?: boolean
  /** @deprecated This is the queued recipient count, not a device receipt. */
  readonly sent: number
  readonly limits: {
    readonly remaining: number
    readonly limit: number
  }
}

export interface SubscriberCount {
  readonly total: number
  readonly active: number
  readonly unsubscribed: number
}

export interface CampaignStats {
  readonly totalSent: number
  readonly totalDelivered: number
  readonly totalClicked: number
  readonly totalFailed: number
  readonly deliveryRate: number
  readonly clickRate: number
}

export type FlowTriggerType = 
  | 'notification_click' 
  | 'notification_impression' 
  | 'notification_dismiss' 
  | 'subscription' 
  | 'unsubscription'

export type FlowStepType = 'send_notification' | 'delay' | 'exit'

export type FlowStatus = 'draft' | 'active' | 'paused' | 'archived'

export interface FlowStepConfig {
  readonly notification?: {
    readonly title: string
    readonly body: string
    readonly iconUrl?: string
    readonly imageUrl?: string
    readonly actionUrl?: string
  }
  readonly delay?: {
    readonly value: number
    readonly unit: 'seconds' | 'minutes' | 'hours' | 'days'
  }
}

export interface FlowStep {
  readonly id: string
  readonly flowId: string
  readonly stepOrder: number
  readonly stepType: FlowStepType
  readonly config: FlowStepConfig
  readonly createdAt: string
  readonly updatedAt: string
}

export interface Flow {
  readonly id: string
  readonly siteId: string
  readonly name: string
  readonly description?: string
  readonly triggerType: FlowTriggerType
  readonly triggerCampaignId?: string
  readonly status: FlowStatus
  readonly executionCount: number
  readonly createdBy?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly steps?: readonly FlowStep[]
}

export interface FlowStepInput {
  readonly stepType: FlowStepType
  readonly config: FlowStepConfig
}

export interface CreateFlow {
  readonly name: string
  readonly description?: string
  readonly triggerType: FlowTriggerType
  readonly triggerCampaignId?: string
  readonly steps?: readonly FlowStepInput[]
}

export interface UpdateFlow {
  readonly name?: string
  readonly description?: string
  readonly triggerType?: FlowTriggerType
  readonly triggerCampaignId?: string
  readonly status?: FlowStatus
  readonly steps?: readonly FlowStepInput[]
}

export interface FlowListParams extends ListParams {
  readonly status?: FlowStatus
}

export type DecisionType = 'confirm' | 'select' | 'input'

export type DecisionStatus = 'pending' | 'answered' | 'expired' | 'cancelled'

// What a decision is about. Recorded on the audit row so a decision can be
// grouped, risk-classified and matched against a permission rule by the same
// machinery the CLI path already uses. `toolName` is the action
// ("refund.create", "database.write"); `toolTarget` is what it acts on. A
// free-text question is still all a caller needs, so both stay optional.
/**
 * Typed arguments of an action. Scalars only: a rule reads these, and a nested
 * object has no comparable value to read.
 */
export type DecisionParameters = Readonly<Record<string, string | number | boolean>>

/**
 * How to render one parameter to the person deciding.
 *
 * Declared here rather than imported, for the same reason AuthorizationVerdict
 * is: this package is MIT and must not depend on Pushary's private core, so the
 * wire values are the contract between them.
 *
 * A currency parameter holds MINOR units — 4800 is EUR 48.00. A float cannot
 * hold money exactly and a pre-formatted string cannot be compared by a rule.
 */
export type PresentedFormat =
  | { readonly kind: 'text' }
  | { readonly kind: 'currency'; readonly currency: string }
  | { readonly kind: 'quantity'; readonly unit?: string }
  | { readonly kind: 'timestamp' }
  | { readonly kind: 'boolean' }

export interface PresentedChange {
  /**
   * A key of `parameters`. The value is read from there and never carried here,
   * so what the person sees and what a rule reads cannot be different numbers.
   */
  readonly parameter: string
  /** What to call it to a person: "Refund amount", not "amount_minor". */
  readonly label: string
  readonly format: PresentedFormat
}

/**
 * The action in business language, for the surfaces a person actually reads.
 *
 * Optional. A caller that sends none keeps the free-text `question` it has
 * always sent; only a caller that claims a presentation is held to it, and an
 * invalid one is refused rather than half-rendered.
 */
export interface ActionPresentation {
  /** The action as a person would name it. "Refund order #4471". */
  readonly label: string
  /** What actually happens. "Returns EUR 48.00 to the customer's card." */
  readonly effect: string
  readonly changes?: readonly PresentedChange[]
  /** Optional. Why this one is worth stopping for. */
  readonly risk?: string
}

export interface DecisionSubject {
  readonly toolName?: string
  readonly toolTarget?: string
  /**
   * Who the action runs on behalf of, e.g. `user:u_44` or `team:billing`. This is
   * the principal, which is not necessarily the person who approves: `externalId`
   * names the recipient of the question, `actor` names whose authority the action
   * claims. Max 120 characters.
   */
  readonly actor?: string
  /** Which deployment the action runs against, e.g. `production`. Max 40 characters. */
  readonly environment?: string
  /**
   * Typed arguments of the action, e.g. `{ amount: 4800, currency: 'EUR' }`.
   * Scalars only, at most 32 keys. Recorded on the audit row so an approval can be
   * read back against what it approved.
   *
   * Rejected as a whole (400) if any value is not a string, a finite number or a
   * boolean, rather than being partly dropped: a rule that reads a missing
   * parameter can only ever decide more permissively than one that reads it.
   */
  readonly parameters?: DecisionParameters
  /**
   * What the person deciding sees, in business language. Its `changes` name
   * parameters rather than carrying values, so display and policy read the same
   * numbers. Refused (400) if it names a parameter you did not send, names one
   * whose name marks it secret, or gives a value a format cannot render.
   */
  readonly presentation?: ActionPresentation
  /**
   * Return a short-lived `approvalUrl` you can deliver yourself, over the email,
   * SMS or in-app inbox you already have for this end-user.
   *
   * Off by default: a capability URL returned on every create is a capability URL
   * in every log, for the majority of decisions that never needed one. The link
   * is bound to this decision, this site and this recipient, and expires.
   */
  readonly approvalUrl?: boolean
}

/** Whether a decision can reach this person, and by whose hands. */
export type DecisionDeliverability = 'push' | 'fallback' | 'unreachable'

export interface DecisionReach {
  readonly externalId: string
  /**
   * `push` — Pushary delivers it. `fallback` — nobody is enrolled, but you know
   * this end-user: open the decision with `approvalUrl: true` and deliver the
   * link yourself. `unreachable` — no end-user was named, so there is nobody to
   * reach and no link to mint.
   */
  readonly deliverability: DecisionDeliverability
  readonly reachable: boolean
  readonly reachableChannels: number
  readonly deviceCount: number
  readonly webEndpoints: number
  readonly hint: string
}

/**
 * What the sandbox's simulated approver does.
 *
 * `approve` is the default. `no_answer` leaves the decision open, which is how
 * you exercise your own fail-closed path without waiting on a real phone.
 *
 * Read only by a key issued on your workspace's sandbox site, where nothing is
 * delivered and nobody is asked. Ignored in production, where the approver is a
 * person.
 */
export type SandboxOutcome = 'approve' | 'deny' | 'no_answer'

export interface CreateDecision extends DecisionSubject {
  readonly question: string
  readonly type?: DecisionType
  readonly options?: readonly string[]
  readonly externalId?: string
  // Approver's email. When set and the partner has connected Slack, the approval is
  // DM'd to that specific person (resolved in the workspace) instead of the shared
  // channel. Also usable as a delivery hint for other channels.
  readonly email?: string
  readonly callbackUrl?: string
  readonly agentName?: string
  readonly context?: string
  readonly placeholder?: string
  readonly expiresInSeconds?: number
  readonly wait?: boolean
  readonly timeoutSeconds?: number
  readonly idempotencyKey?: string
  readonly poweredBy?: boolean
  // Refuse (409) instead of opening a decision the end-user cannot receive: when
  // true and the externalId has no enrolled device or push subscription, create
  // throws with an "unreachable" error rather than returning a decision that will
  // expire unanswered. Leave unset to open the decision anyway (it stays available
  // on the hosted decision page).
  readonly requireReachable?: boolean
  readonly sandboxOutcome?: SandboxOutcome
}


// The three answers the authorization boundary can give. Declared here rather
// than imported, because this package is MIT and must not depend on Pushary's
// private core; the wire values are the contract between them.
export type AuthorizationVerdict = 'allow' | 'deny' | 'requires_human'

// Everything POST /authorize reads. Split out from AuthorizeRequest because the
// evaluation is usable on its own: a caller that owns its escalation asks only
// this, and the ask-shaped fields below would be dead weight on that call.
export interface AuthorizationQuery extends DecisionSubject {
  /** The action being authorized. Required: a rule has to name it. */
  readonly toolName: string
  /** Your own id for the end-user this action belongs to. */
  readonly externalId?: string
  /**
   * Shown to the person, if policy defers to one. Defaults to the action and its
   * target, so a caller that only names the action still asks a readable question.
   */
  readonly question?: string
  readonly agentName?: string
}

export interface AuthorizeRequest extends AuthorizationQuery {
  /** Forwarded to the ask, and used only when policy defers to a person. */
  readonly timeoutMs?: number
  readonly expiresInSeconds?: number
  readonly idempotencyKey?: string
  readonly requireReachable?: boolean
}

export interface AuthorizeResult {
  /** Fail-closed. False for a denial, and false when nobody answered. */
  readonly approved: boolean
  /** What settled it: a rule, or a person. */
  readonly resolvedBy: 'policy' | 'human'
  /** The rule that decided, or null when no rule named the action. */
  readonly policy: string | null
  readonly reason: string
  /** The decision opened when policy deferred to a person, else null. */
  readonly decisionId: string | null
  /** The audit row a policy-settled authorization produced, else null. */
  readonly authorizationId: string | null
}

// Raw shape of POST /authorize, before the SDK resolves a requires_human verdict
// by asking a person.
export interface AuthorizationEvaluation {
  readonly verdict: AuthorizationVerdict
  readonly policy: string | null
  readonly reason: string
  readonly authorizationId: string | null
}

// ---------------------------------------------------------------------------
// The permit: one authorization, one execution.
//
// A verdict says an action MAY happen. It does not say it happened once. Between
// the two sit every framework retry, every resumed run and every concurrent
// worker, and a refund authorized once and issued twice is the failure this
// boundary exists to prevent.
// ---------------------------------------------------------------------------

/**
 * The exact subject an authorization was recorded against.
 *
 * Carried from the gate to the consume rather than rebuilt, because the two have
 * to name the same action and rebuilding it is a second chance for them not to.
 * The server digests this and what it recorded, and refuses unless they match.
 */
export interface AuthorizationBinding {
  /** The settled authorization: a policy verdict's id, or an approved decision's id. */
  readonly authorizationId: string
  readonly toolName: string
  readonly toolTarget?: string
  readonly actor?: string
  readonly environment?: string
  readonly externalId?: string
  readonly parameters?: DecisionParameters
}

/**
 * Who allowed it, frozen when it was allowed.
 *
 * A rule can be edited and a member can lose their seat. An authorization that
 * can only say "something allowed this" is not an audit trail, so the deciding
 * authority is copied onto the permit and never updated.
 */
export type AuthorizationAuthority =
  | {
      readonly kind: 'policy'
      readonly rulePattern?: string
      readonly authorizationRuleId?: string
      readonly policyId?: string
    }
  | {
      readonly kind: 'human'
      readonly answeredAt: string
      readonly answerSource?: string
      readonly approverUserId?: string
      readonly approverExternalId?: string
    }

/** Why a consume was refused. Every branch is a refusal; none of them means allowed. */
export type PermitRefusal = 'not_authorized' | 'action_mismatch' | 'expired' | 'already_consumed'

export type PermitExecutionState = 'running' | 'succeeded' | 'failed'

export interface ConsumedAuthorization {
  readonly permitId: string
  readonly authority: AuthorizationAuthority
  /** ISO-8601. The permit is spent already; this is when it would have stopped being spendable. */
  readonly expiresAt: string
}

export type ConsumeAuthorizationResult =
  | { readonly consumed: true; readonly permit: ConsumedAuthorization }
  | {
      readonly consumed: false
      readonly refusal: PermitRefusal
      readonly reason: string
      /** On `already_consumed`, what the winning execution did. */
      readonly executionState?: PermitExecutionState
    }

export type ExecutionOutcome = 'succeeded' | 'failed'

export interface ExecutionReceipt {
  readonly permitId: string
  readonly outcome: ExecutionOutcome
  /** Bounded and redacted server-side. What the action did, or why it did not. */
  readonly summary?: string
}

// Reachability of the end-user at create time: whether the decision can actually
// reach them, and over how many channels. Present only for a decision addressed to
// a specific externalId; lets an approve-gate tell "no human reachable" apart from
// "human declined."
export interface DecisionReachability {
  readonly reachable?: boolean
  readonly reachableChannels?: number
  readonly deviceCount?: number
}

export interface DecisionResult extends DecisionReachability {
  readonly decisionId: string
  readonly status: DecisionStatus
  readonly answered: boolean
  readonly value?: string | null
  readonly type?: DecisionType
  readonly question?: string
  readonly pollUrl?: string
  readonly decisionPageUrl?: string
  readonly expiresInSeconds?: number
  readonly idempotent?: boolean
  readonly hint?: string
}

export interface Decision {
  readonly decisionId: string
  readonly status: DecisionStatus
  readonly answered: boolean
  readonly value: string | null
  readonly type: DecisionType
  readonly question: string
  readonly options: readonly string[] | null
  readonly externalId: string | null
  // The free-text context passed at create time. Echoed here and in the webhook.
  readonly context: string | null
  readonly createdAt: string
  readonly answeredAt: string | null
  readonly expiresAt: string | null
}

export interface DecisionAnswerResult {
  readonly decisionId: string
  readonly status: DecisionStatus
  readonly answered: boolean
  readonly value?: string | null
}

export interface CancelDecisionResult {
  readonly decisionId: string
  readonly cancelled: boolean
  readonly status: string
}

export interface WebhookSecret {
  readonly webhookSecret: string
}

// The JSON body Pushary POSTs to your callbackUrl when a decision resolves. Verify
// verifyWebhookSignature(rawBody, header, secret) against the X-Pushary-Signature
// header BEFORE trusting it, then read `answer` (canonical; `value` is an alias)
// keyed by `correlationId`. `context` echoes what you passed at create time, so a
// stateless resume can read your own state off it without a correlationId map.
export interface DecisionCallback {
  readonly correlationId: string
  readonly answer: string
  readonly value: string
  readonly answeredAt: string
  readonly context?: string
}

// Returned by enroll(): a single-use, short-lived link to show one of your
// end-users so they can turn on phone approvals in one tap. Cache the resulting
// enrollment (phone <-> externalId), NOT this link — it is single-use and expires.
export interface EnrollResult {
  readonly externalId: string
  readonly token: string
  // Native app deep link (pushary://enroll?token=...) — opens the Pushary app directly.
  readonly deepLink: string
  // Universal/app link (https://pushary.com/e/<token>) — safe to render as a
  // button, QR code, or send over email/SMS/Slack. Opens the app if installed,
  // else a web-push fallback page.
  readonly universalLink: string
  readonly expiresInSeconds: number
}

// Input for decisions.ask() — create a decision and block (durably polling)
// until the human answers or the deadline passes.
export interface AskDecision extends DecisionSubject {
  /** Cancel the local wait; the remote decision remains recoverable. */
  readonly signal?: AbortSignal
  readonly question: string
  readonly type?: DecisionType
  readonly options?: readonly string[]
  readonly externalId?: string
  readonly email?: string
  readonly agentName?: string
  readonly context?: string
  readonly placeholder?: string
  readonly expiresInSeconds?: number
  readonly idempotencyKey?: string
  readonly poweredBy?: boolean
  readonly callbackUrl?: string
  readonly requireReachable?: boolean
  readonly sandboxOutcome?: SandboxOutcome
  readonly presentation?: ActionPresentation
  readonly approvalUrl?: boolean
  // Total create-and-poll budget before returning (default 55_000ms,
  // serverless-safe). The decision itself stays answerable for its full TTL, so
  // an {answered:false} return can still be resolved later via get() or a webhook.
  readonly timeoutMs?: number
}

export interface AskResult extends DecisionReachability {
  readonly decisionId: string
  readonly status: DecisionStatus
  readonly answered: boolean
  readonly value: string | null
  readonly type: DecisionType
  // Fail-closed: true only when answered AND (for confirm) affirmative.
  readonly approved: boolean
}

// Per-end-user (bound) key issuance for multi-tenant Partners. Mint one with
// keys.issue({ externalId }) for a single end-user session, hand it to the agent
// acting for that user, and revoke it with keys.revoke(keyPrefix) when done. A
// bound key can only create/resolve decisions and enroll that exact end-user.
export interface IssueBoundKey {
  readonly externalId: string
  readonly name?: string
  readonly expiresInSeconds?: number
}

export interface BoundKeyResult {
  // The full key (pk_....secret), shown once. Store it as the session credential;
  // it cannot be retrieved again.
  readonly apiKey: string
  readonly keyPrefix: string
  readonly scope: 'bound'
  readonly boundExternalId: string
  readonly expiresAt: string | null
}

export interface BoundKeySummary {
  readonly keyPrefix: string
  readonly name: string
  readonly boundExternalId: string | null
  readonly isActive: boolean
  readonly lastUsedAt: string | null
  readonly expiresAt: string | null
  readonly createdAt: string
}

export interface RevokeKeyResult {
  readonly keyPrefix: string
  readonly revoked: boolean
}

export type RequestFn = <T>(
  method: string,
  path: string,
  body?: unknown,
  options?: { readonly signal?: AbortSignal },
) => Promise<T>
