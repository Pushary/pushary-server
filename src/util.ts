import { createHash } from 'crypto'
import type { DecisionStatus, DecisionType } from './types'

// A collision-safe idempotency key that is STABLE across process restarts
// (unlike the builtin salted hash()), so a retried create reuses the same key
// and never asks the same human twice. Pass the parts that make the ask unique
// (e.g. [externalId, stepId, question]). Parts are joined with a NUL separator
// so ['a', 'bc'] and ['ab', 'c'] never collide.
export const deterministicKey = (parts: readonly string[]): string =>
  createHash('sha256').update(parts.join('\x00')).digest('hex').slice(0, 40)

export const decisionFingerprint = (value: unknown): string => {
  const ancestors = new Set<object>()
  const serialize = (item: unknown): string => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item)
    if (typeof item !== 'object' || ancestors.has(item)) {
      throw new TypeError('Pushary: decision identity must contain finite, acyclic JSON values.')
    }
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new TypeError('Pushary: decision identity must contain plain JSON objects.')
    }
    ancestors.add(item)
    const entries = Object.entries(item)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    const serialized = Array.isArray(item)
      ? `[${Array.from(item, serialize).join(',')}]`
      : `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${serialize(entry)}`).join(',')}}`
    ancestors.delete(item)
    return serialized
  }
  return createHash('sha256').update(serialize(value)).digest('hex')
}

const AFFIRMATIVE: ReadonlySet<string> = new Set([
  'yes',
  'y',
  'approve',
  'approved',
  'ok',
  'okay',
  'confirm',
  'accept',
  'true',
])

// Fail-closed approval check. A `confirm` decision is approved ONLY on an
// affirmative answer; `select`/`input` decisions are "approved" once answered.
// Anything not answered — pending, expired, or cancelled — is NOT approved.
export const isApproved = (decision: {
  readonly status: DecisionStatus
  readonly type?: DecisionType
  readonly value: string | null
}): boolean => {
  if (decision.status !== 'answered') return false
  if (decision.type && decision.type !== 'confirm') return true
  return decision.value != null && AFFIRMATIVE.has(decision.value.trim().toLowerCase())
}
