import { PusharyApiError } from './error'
import type {
  AuthorizationBinding,
  ConsumeAuthorizationResult,
  ConsumedAuthorization,
  ExecutionReceipt,
  PermitExecutionState,
  PermitRefusal,
  RequestFn,
} from './types'

const REFUSALS: readonly PermitRefusal[] = [
  'not_authorized',
  'action_mismatch',
  'expired',
  'already_consumed',
]

const EXECUTION_STATES: readonly PermitExecutionState[] = ['running', 'succeeded', 'failed']

// A refusal is an answer, not a failure: the server looked, and said no. A
// transport error is neither, and must not be dressed up as one — a caller that
// reads "already consumed" stops, and a caller that reads a network error may
// try again. Only a body the server actually sent gets read as a refusal.
const refusalOf = (error: unknown): ConsumeAuthorizationResult | null => {
  if (!(error instanceof PusharyApiError)) return null
  const body = error.body as { refusal?: unknown; executionState?: unknown } | undefined
  const refusal = body?.refusal
  if (typeof refusal !== 'string' || !REFUSALS.includes(refusal as PermitRefusal)) return null
  const state = body?.executionState
  return {
    consumed: false,
    refusal: refusal as PermitRefusal,
    reason: error.message,
    ...(typeof state === 'string' && EXECUTION_STATES.includes(state as PermitExecutionState)
      ? { executionState: state as PermitExecutionState }
      : {}),
  }
}

/**
 * Spend one settled authorization, at most once.
 *
 * Re-states the action about to run. That is the point: the server digests what
 * you claim and what it recorded, and refuses unless they are the same action.
 * An amount changed between the approval and the execution does not fail a check
 * that could be skipped — it simply has no permit.
 *
 * Refusals come back as `consumed: false` with a machine-readable reason.
 * Anything else throws, because "the network was down" is not "you may not do
 * this", and a caller that cannot tell them apart will eventually guess wrong.
 */
export const createConsumeAuthorization =
  (request: RequestFn) =>
  async (binding: AuthorizationBinding): Promise<ConsumeAuthorizationResult> => {
    try {
      const permit = await request<ConsumedAuthorization>('POST', '/authorizations/consume', {
        authorizationId: binding.authorizationId,
        toolName: binding.toolName,
        toolTarget: binding.toolTarget,
        actor: binding.actor,
        environment: binding.environment,
        externalId: binding.externalId,
        parameters: binding.parameters,
      })
      return { consumed: true, permit }
    } catch (error) {
      const refused = refusalOf(error)
      if (refused) return refused
      throw error
    }
  }

/**
 * Say what the authorized action did.
 *
 * The evidence half. "Was this allowed" and "did this happen" are different
 * questions, and only the second one answers a customer asking where their
 * refund is. The first report wins; a late duplicate cannot rewrite it.
 */
export const createRecordExecution =
  (request: RequestFn) =>
  (receipt: ExecutionReceipt): Promise<{ readonly executionState: PermitExecutionState }> =>
    request('POST', `/authorizations/${encodeURIComponent(receipt.permitId)}/receipt`, {
      outcome: receipt.outcome,
      summary: receipt.summary,
    })
