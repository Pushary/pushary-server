import type { RequestContext, RequestFn } from './types'
import { PusharyApiError } from './error'

const buildUrl = (baseUrl: string, path: string, params?: Record<string, unknown>): string => {
  // Build from the full absolute URL so the base path (e.g. /api/v1/server) is
  // preserved. `new URL(path, baseUrl)` treats a leading-slash path as absolute
  // and would drop that prefix, sending GET-with-query calls to the wrong URL.
  const url = new URL(`${baseUrl}${path}`)

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value))
      }
    })
  }
  
  return url.toString()
}

const handleResponse = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    // The API returns its reason under `error`; older paths use `message`. Read
    // both so callers get the real reason (e.g. "No subscribers found") instead
    // of a bare "HTTP 400" they cannot classify.
    const body = (await response.json().catch(() => ({}))) as {
      message?: string
      error?: string
      code?: string
    }
    // PusharyApiError extends Error, so an existing `catch (e) { e.message }`
    // is unaffected. It carries the status too, because the reason to branch on
    // a failure (re-authenticate vs back off vs retry) was previously only
    // recoverable by string-matching this message, which is not a stable API.
    throw new PusharyApiError(body.message || body.error || `HTTP ${response.status}`, {
      status: response.status,
      statusText: response.statusText,
      code: body.code,
      body,
    })
  }
  return response.json() as Promise<T>
}

export const createRequest = (ctx: RequestContext): RequestFn =>
  async <T>(method: string, path: string, body?: unknown, options?: { readonly signal?: AbortSignal }): Promise<T> => {
    const isGet = method === 'GET'
    const url = isGet && body 
      ? buildUrl(ctx.baseUrl, path, body as Record<string, unknown>)
      : `${ctx.baseUrl}${path}`
    
    options?.signal?.throwIfAborted()
    const controller = new AbortController()
    const abort = (): void => controller.abort(options?.signal?.reason)
    options?.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(new DOMException('Pushary request timed out', 'TimeoutError')), ctx.timeoutMs ?? 65_000)
    try {
      const response = await fetch(url, {
        method,
        signal: controller.signal,
        headers: ctx.headers,
        body: !isGet && body ? JSON.stringify(body) : undefined,
      })
      const result = await handleResponse<T>(response)
      controller.signal.throwIfAborted()
      return result
    } catch (error) {
      controller.signal.throwIfAborted()
      throw error
    } finally {
      clearTimeout(timer)
      options?.signal?.removeEventListener('abort', abort)
    }
  }
