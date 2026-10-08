import type {
  RequestFn,
  IssueBoundKey,
  BoundKeyResult,
  BoundKeySummary,
  RevokeKeyResult,
} from '../types'

// Per-end-user (bound) key issuance for multi-tenant Partners. Call issue() from
// your backend with your own (unbound, Partner-plan) key to mint a child key bound
// to one end-user, hand that key to the agent runtime acting for that user, then
// revoke() it when the session ends. A bound key can only create, read and cancel
// decisions for that exact end-user, so a prompt-injected agent can
// never reach another of your users. It cannot enroll devices or answer a decision; answer from your
// server with your full-access key. Requires the Partner plan.
export interface KeysResource {
  // Mint a key bound to externalId. The full key is returned once in `apiKey` and
  // cannot be retrieved again — store it as the session credential.
  readonly issue: (data: IssueBoundKey) => Promise<BoundKeyResult>
  // List this site's bound keys (never the secret) for audit/rotation.
  readonly list: () => Promise<readonly BoundKeySummary[]>
  // Revoke (deactivate) a bound key by its prefix. Returns revoked:false if the
  // prefix is unknown or already inactive.
  readonly revoke: (keyPrefix: string) => Promise<RevokeKeyResult>
}

export const createKeysResource = (request: RequestFn): KeysResource =>
  Object.freeze({
    issue: (data: IssueBoundKey) => request<BoundKeyResult>('POST', '/keys', data),
    list: () =>
      request<{ keys: readonly BoundKeySummary[] }>('GET', '/keys').then((r) => r.keys),
    revoke: (keyPrefix: string) =>
      request<RevokeKeyResult>('DELETE', `/keys/${encodeURIComponent(keyPrefix)}`),
  })
