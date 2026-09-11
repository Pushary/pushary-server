import type {
  RequestFn,
  Subscriber,
  SubscriberListParams,
  UpdateSubscriber,
  PaginatedResponse,
  SubscriberCount,
} from '../types'

export interface SubscribersResource {
  readonly list: (params?: SubscriberListParams) => Promise<PaginatedResponse<Subscriber>>
  readonly get: (id: string) => Promise<Subscriber>
  readonly update: (id: string, data: UpdateSubscriber) => Promise<Subscriber>
  readonly delete: (id: string) => Promise<void>
  readonly count: () => Promise<SubscriberCount>
}

export const createSubscribersResource = (request: RequestFn): SubscribersResource =>
  Object.freeze({
    list: (params?: SubscriberListParams) =>
      request<PaginatedResponse<Subscriber>>('GET', '/subscribers', params),
    
    get: (id: string) =>
      request<Subscriber>('GET', `/subscribers/${id}`),
    
    update: (id: string, data: UpdateSubscriber) =>
      request<Subscriber>('PATCH', `/subscribers/${id}`, data),
    
    delete: (id: string) =>
      request<void>('DELETE', `/subscribers/${id}`),
    
    count: () =>
      request<SubscriberCount>('GET', '/subscribers/count'),
  })

