import type {
  AuthorizationEvaluation,
  AuthorizationQuery,
  AuthorizeRequest,
  AuthorizeResult,
  DecisionSubject,
  RequestFn,
} from './types'
import type { DecisionsResource } from './resources/decisions'

const defaultQuestion = (toolName: string, toolTarget?: string): string =>
  `Approve ${toolName}${toolTarget ? ` ${toolTarget}` : ''}?`

// The evaluation and the ask must describe the same action. Built once so a field
// added to the subject cannot reach one call and not the other, which would let a
// decision be recorded under a different description than the one policy saw.
export const authorizationSubject = (input: DecisionSubject): DecisionSubject => ({
  toolName: input.toolName,
  toolTarget: input.toolTarget,
  actor: input.actor,
  environment: input.environment,
  parameters: input.parameters,
})

/**
 * The raw boundary: what the site's policy says about one action, with nobody
 * paged and no decision opened.
 *
 * Exported separately from {@link createAuthorize} because a caller that owns its
 * own escalation — the adapter gate, or a custom harness with its own approval
 * surface — needs to tell "policy had no opinion" apart from "the ask failed".
 * Composing the two calls hides that difference, and the two failures want
 * opposite handling.
 */
export const createEvaluateAuthorization =
  (request: RequestFn) =>
  (input: AuthorizationQuery): Promise<AuthorizationEvaluation> =>
    request<AuthorizationEvaluation>('POST', '/authorize', {
      ...authorizationSubject(input),
      externalId: input.externalId,
      question: input.question,
      agentName: input.agentName,
    })

/**
 * Ask policy first, and a person only if policy defers.
 *
 * Two calls rather than one server round trip on purpose. POST /authorize
 * evaluates and nothing else, so every limit, reachability check and delivery
 * rung stays in the one path that already owns them, and this composes the two.
 * The extra hop only happens when a human is needed, where it is lost in the
 * time that person takes to answer.
 *
 * Fail-closed throughout: a denial and an unanswered ask both return
 * approved: false, and the reason says which it was.
 */
export const createAuthorize = (request: RequestFn, decisions: DecisionsResource) => {
  const evaluate = createEvaluateAuthorization(request)

  return async (input: AuthorizeRequest): Promise<AuthorizeResult> => {
    const subject = authorizationSubject(input)
    const evaluation = await evaluate(input)

    if (evaluation.verdict !== 'requires_human') {
      return {
        approved: evaluation.verdict === 'allow',
        resolvedBy: 'policy',
        policy: evaluation.policy,
        reason: evaluation.reason,
        decisionId: null,
        authorizationId: evaluation.authorizationId,
      }
    }

    const answer = await decisions.ask({
      question: input.question ?? defaultQuestion(input.toolName, input.toolTarget),
      type: 'confirm',
      externalId: input.externalId,
      agentName: input.agentName,
      ...subject,
      timeoutMs: input.timeoutMs,
      expiresInSeconds: input.expiresInSeconds,
      idempotencyKey: input.idempotencyKey,
      requireReachable: input.requireReachable,
    })

    return {
      approved: answer.approved,
      resolvedBy: 'human',
      policy: evaluation.policy,
      reason: answer.approved
        ? 'A person approved it.'
        : answer.answered
          ? 'A person denied it.'
          : 'Nobody answered, so this was not approved.',
      decisionId: answer.decisionId,
      authorizationId: null,
    }
  }
}
