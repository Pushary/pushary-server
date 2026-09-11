/**
 * Thrown for any non-2xx response from the API.
 *
 * Extends Error rather than replacing it, so every existing `catch (e)` that
 * reads `e.message` keeps working unchanged. What it adds is the thing callers
 * previously had to string-match the message for: an HTTP status they can branch
 * on. Telling a revoked key (401) apart from a plan limit (403), a bad argument
 * (400) and an outage (5xx) is the difference between "stop and re-authenticate"
 * and "retry in a minute", and message text is not a stable API to decide that on.
 */
export class PusharyApiError extends Error {
  /** HTTP status of the response that failed. */
  readonly status: number
  /** HTTP status text, when the runtime provides one. */
  readonly statusText: string
  /** The API's own machine-readable error code, when it sent one. */
  readonly code?: string
  /** The parsed response body, for anything the fields above do not cover. */
  readonly body?: unknown

  constructor(
    message: string,
    init: { status: number; statusText?: string; code?: string; body?: unknown }
  ) {
    super(message)
    this.name = 'PusharyApiError'
    this.status = init.status
    this.statusText = init.statusText ?? ''
    this.code = init.code
    this.body = init.body
    // Restores the prototype chain so `err instanceof PusharyApiError` holds
    // even when this package is consumed as ES5-targeted CommonJS.
    Object.setPrototypeOf(this, PusharyApiError.prototype)
  }

  /** The key is missing, malformed, or revoked. Re-authenticate; do not retry. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403
  }

  /** Rate limited. Back off and retry. */
  get isRateLimited(): boolean {
    return this.status === 429
  }

  /** Server-side fault. Safe to retry an idempotent call. */
  get isServerError(): boolean {
    return this.status >= 500
  }
}
