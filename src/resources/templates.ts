import type {
  RequestFn,
  Template,
  CreateTemplate,
  UpdateTemplate,
  ListParams,
  PaginatedResponse,
} from '../types'

export interface TemplatesResource {
  readonly list: (params?: ListParams) => Promise<PaginatedResponse<Template>>
  readonly create: (data: CreateTemplate) => Promise<Template>
  readonly get: (id: string) => Promise<Template>
  readonly update: (id: string, data: UpdateTemplate) => Promise<Template>
  readonly delete: (id: string) => Promise<void>
}

export const createTemplatesResource = (request: RequestFn): TemplatesResource =>
  Object.freeze({
    list: (params?: ListParams) =>
      request<PaginatedResponse<Template>>('GET', '/templates', params),
    
    create: (data: CreateTemplate) =>
      request<Template>('POST', '/templates', data),
    
    get: (id: string) =>
      request<Template>('GET', `/templates/${id}`),
    
    update: (id: string, data: UpdateTemplate) =>
      request<Template>('PATCH', `/templates/${id}`, data),
    
    delete: (id: string) =>
      request<void>('DELETE', `/templates/${id}`),
  })

