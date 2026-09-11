import { createHmac, timingSafeEqual } from 'crypto'
import type { DecisionCallback } from './types'

// The header carrying the HMAC-SHA256 signature of the raw callback body.
export const SIGNATURE_HEADER = 'x-pushary-signature'

// Verify a Pushary webhook. Pass the RAW request body (not re-serialized JSON),
// the X-Pushary-Signature header, and your webhook secret (decisions.getWebhookSecret()).
// Constant-time comparison; returns false on any mismatch.
export const verifyWebhookSignature = (
  rawBody: string,
  signature: string | null | undefined,
  secret: string,
): boolean => {
  if (!signature || !secret) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// Parse a verified decision callback body into a typed object. Returns null if the
// body is not a decision callback (missing correlationId/answer). Verify the
// signature FIRST — this does no verification. Read `answer` (canonical) keyed by
// `correlationId`; `context` echoes what you passed at create time.
export const parseDecisionCallback = (rawBody: string): DecisionCallback | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  if (typeof p.correlationId !== 'string' || typeof p.answer !== 'string') return null
  return {
    correlationId: p.correlationId,
    answer: p.answer,
    value: typeof p.value === 'string' ? p.value : p.answer,
    answeredAt: typeof p.answeredAt === 'string' ? p.answeredAt : '',
    ...(typeof p.context === 'string' ? { context: p.context } : {}),
  }
}
