import type {
  RequestFn,
  Flow,
  CreateFlow,
  UpdateFlow,
  FlowListParams,
  PaginatedResponse,
} from '../types'

export interface FlowsResource {
  readonly list: (params?: FlowListParams) => Promise<PaginatedResponse<Flow>>
  readonly create: (data: CreateFlow) => Promise<Flow>
  readonly get: (id: string) => Promise<Flow>
  readonly update: (id: string, data: UpdateFlow) => Promise<Flow>
  readonly delete: (id: string) => Promise<void>
  readonly activate: (id: string) => Promise<Flow>
  readonly pause: (id: string) => Promise<Flow>
}

export const createFlowsResource = (request: RequestFn): FlowsResource =>
  Object.freeze({
    list: (params?: FlowListParams) =>
      request<PaginatedResponse<Flow>>('GET', '/flows', params),
    
    create: (data: CreateFlow) =>
      request<Flow>('POST', '/flows', data),
    
    get: (id: string) =>
      request<Flow>('GET', `/flows/${id}`),
    
    update: (id: string, data: UpdateFlow) =>
      request<Flow>('PATCH', `/flows/${id}`, data),
    
    delete: (id: string) =>
      request<void>('DELETE', `/flows/${id}`),
    
    activate: (id: string) =>
      request<Flow>('POST', `/flows/${id}/activate`),
    
    pause: (id: string) =>
      request<Flow>('POST', `/flows/${id}/pause`),
  })
