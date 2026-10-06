import { z } from "zod";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

/**
 * `size`     – items per page (1..MAX_PAGE_SIZE, default DEFAULT_PAGE_SIZE)
 * `position` – zero-based offset of the first item (default 0)
 * Invalid values are rejected (HTTP 400 VALIDATION_ERROR) rather than silently clamped.
 */
export const paginationSchema = z.object({
  size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  position: z.coerce.number().int().min(0).default(0),
});

export type PaginationInput = z.infer<typeof paginationSchema>;

export const parsePagination = (input: unknown): PaginationInput => paginationSchema.parse(input);

export interface PageInfo {
  size: number;
  position: number;
  hasNextPage: boolean;
  nextPosition: number | null;
}

export interface Paginated<T> {
  items: T[];
  pageInfo: PageInfo;
}

/**
 * Repositories fetch `size + 1` rows (skip/limit in the database). The extra
 * row only tells us whether another page exists and is trimmed here.
 */
export const toPaginated = <T>(rows: T[], { size, position }: PaginationInput): Paginated<T> => {
  const hasNextPage = rows.length > size;
  return {
    items: hasNextPage ? rows.slice(0, size) : rows,
    pageInfo: {
      size,
      position,
      hasNextPage,
      nextPosition: hasNextPage ? position + size : null,
    },
  };
};
