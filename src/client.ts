import type {
  PusharyConfig,
  RequestContext,
  EnrollResult,
  AuthorizationEvaluation,
  AuthorizationQuery,
  DecisionReach,
  AuthorizeRequest,
  AuthorizeResult,
  AuthorizationBinding,
  ConsumeAuthorizationResult,
  ExecutionReceipt,
  PermitExecutionState,
} from './types'
import { createRequest } from './request'
import { createSubscribersResource, type SubscribersResource } from './resources/subscribers'
import { createCampaignsResource, type CampaignsResource } from './resources/campaigns'
import { createTemplatesResource, type TemplatesResource } from './resources/templates'
import { createNotificationsResource, type NotificationsResource } from './resources/notifications'
import { createFlowsResource, type FlowsResource } from './resources/flows'
import { createDecisionsResource, type DecisionsResource } from './resources/decisions'
import { createKeysResource, type KeysResource } from './resources/keys'
import { createRemindersResource, type RemindersResource } from './resources/reminders'
import { createAuthorize, createEvaluateAuthorization } from './authorize'
import { createConsumeAuthorization, createRecordExecution } from './permits'

const DEFAULT_BASE_URL = 'https://pushary.com/api/v1/server'

export interface PusharyServer {
  readonly reminders: RemindersResource
  readonly subscribers: SubscribersResource
  readonly campaigns: CampaignsResource
  readonly templates: TemplatesResource
  readonly notifications: NotificationsResource
  readonly flows: FlowsResource
  readonly decisions: DecisionsResource
  // Mint/rotate per-end-user bound keys for multi-tenant Partner integrations.
  readonly keys: KeysResource
  // Ask policy whether one action may proceed, and a person only if policy
  // defers. allow and deny come back without anyone being paged. Requires the
  // Partner plan.
  readonly authorize: (input: AuthorizeRequest) => Promise<AuthorizeResult>
  // The verdict alone, with no decision opened and nobody paged. For a caller
  // that owns its own escalation and needs to tell "policy deferred" apart from
  // "the ask failed", which `authorize` folds together. Requires the Partner plan.
  readonly evaluateAuthorization: (input: AuthorizationQuery) => Promise<AuthorizationEvaluation>
  // Spend one settled authorization, at most once. Re-state the action you are
  // about to run: the server refuses unless it is the action that was approved.
  // Requires the Partner plan.
  readonly consumeAuthorization: (binding: AuthorizationBinding) => Promise<ConsumeAuthorizationResult>
  // Say what the authorized action did. The first report wins.
  readonly recordExecution: (receipt: ExecutionReceipt) => Promise<{ readonly executionState: PermitExecutionState }>
  // Connect one of your end-users' phones (keyless, no Pushary account for them).
  // Returns a single-use universalLink to show them; one tap turns on approvals.
  // Requires the Partner plan.
  readonly enroll: (externalId: string) => Promise<EnrollResult>
  // Can this end-user be reached, and by whose hands? A read-only preflight, so
  // you can decide how to deliver BEFORE opening a decision and parking a run on
  // it. Opens nothing, mints nothing, costs no quota.
  readonly reachability: (externalId: string) => Promise<DecisionReach>
}

const validateApiKey = (apiKey: string): void => {
  if (!apiKey) {
    throw new Error('API key is required. Get your API key from https://pushary.com/dashboard/agent/settings')
  }
  
  if (!apiKey.includes('.')) {
    throw new Error('Invalid API key format. Use the full API key (pk_xxx.xxx)')
  }
}

const createContext = (config: PusharyConfig): RequestContext => {
  validateApiKey(config.apiKey)
  
  return Object.freeze({
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    timeoutMs: config.requestTimeoutMs ?? 65_000,
    headers: Object.freeze({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    }),
  })
}

export const createPusharyServer = (config: PusharyConfig): PusharyServer => {
  const ctx = createContext(config)
  const request = createRequest(ctx)
  
  const decisions = createDecisionsResource(request)

  return Object.freeze({
    subscribers: createSubscribersResource(request),
    campaigns: createCampaignsResource(request),
    templates: createTemplatesResource(request),
    notifications: createNotificationsResource(request),
    flows: createFlowsResource(request),
    decisions,
    keys: createKeysResource(request),
    reminders: createRemindersResource(request),
    authorize: createAuthorize(request, decisions),
    evaluateAuthorization: createEvaluateAuthorization(request),
    consumeAuthorization: createConsumeAuthorization(request),
    recordExecution: createRecordExecution(request),
    enroll: (externalId: string) => request<EnrollResult>('POST', '/enroll', { externalId }),
    reachability: (externalId: string) =>
      request<DecisionReach>('GET', '/reachability', { externalId }),
  })
}
