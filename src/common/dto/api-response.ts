/** Success envelopes (master plan §7.3). Controllers return these explicitly. */
export interface ApiResponse<T> {
  data: T;
}

export interface PageMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: PageMeta;
}
