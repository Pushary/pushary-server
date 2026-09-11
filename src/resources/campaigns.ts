import type {
  RequestFn,
  Campaign,
  CreateCampaign,
  UpdateCampaign,
  ListParams,
  PaginatedResponse,
  CampaignStats,
} from '../types'

export interface CampaignsResource {
  readonly list: (params?: ListParams) => Promise<PaginatedResponse<Campaign>>
  readonly create: (data: CreateCampaign) => Promise<Campaign>
  readonly get: (id: string) => Promise<Campaign>
  readonly update: (id: string, data: UpdateCampaign) => Promise<Campaign>
  readonly delete: (id: string) => Promise<void>
  readonly send: (id: string) => Promise<Campaign>
  readonly pause: (id: string) => Promise<Campaign>
  readonly resume: (id: string) => Promise<Campaign>
  readonly stats: (id: string) => Promise<CampaignStats>
}

export const createCampaignsResource = (request: RequestFn): CampaignsResource =>
  Object.freeze({
    list: (params?: ListParams) =>
      request<PaginatedResponse<Campaign>>('GET', '/campaigns', params),
    
    create: (data: CreateCampaign) =>
      request<Campaign>('POST', '/campaigns', data),
    
    get: (id: string) =>
      request<Campaign>('GET', `/campaigns/${id}`),
    
    update: (id: string, data: UpdateCampaign) =>
      request<Campaign>('PATCH', `/campaigns/${id}`, data),
    
    delete: (id: string) =>
      request<void>('DELETE', `/campaigns/${id}`),
    
    send: (id: string) =>
      request<Campaign>('POST', `/campaigns/${id}/send`),
    
    pause: (id: string) =>
      request<Campaign>('POST', `/campaigns/${id}/pause`),
    
    resume: (id: string) =>
      request<Campaign>('POST', `/campaigns/${id}/resume`),
    
    stats: (id: string) =>
      request<CampaignStats>('GET', `/campaigns/${id}/stats`),
  })

