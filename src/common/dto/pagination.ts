import type { PageMeta } from './api-response.js';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export function pageMeta(
  page: number,
  pageSize: number,
  totalItems: number,
): PageMeta {
  return {
    page,
    pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / pageSize),
  };
}
