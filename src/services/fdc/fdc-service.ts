/**
 * @fileoverview USDA FoodData Central API service — search, single-food fetch, and batch fetch.
 * @module services/fdc/fdc-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  FdcDataType,
  FoodDetail,
  FoodNutrient,
  FoodPortion,
  RawFoodDetail,
  RawFoodNutrient,
  RawFoodPortion,
  RawSearchFood,
  RawSearchResponse,
  SearchResultFood,
} from './types.js';

const BASE_URL = 'https://api.nal.usda.gov/fdc/v1';
const TIMEOUT_MS = 15_000;
/** Total budget for one FDC call across every attempt, backoff, and Retry-After. */
const DEADLINE_MS = 45_000;

// ---- Normalization helpers ----

function normalizeNutrientFromSearch(raw: RawFoodNutrient): {
  id: number;
  name: string;
  amount: number;
  unit: string;
} | null {
  const id = raw.nutrientId;
  const name = raw.nutrientName?.trim();
  const amount = raw.value;
  const unit = raw.unitName?.trim() ?? '';
  if (id == null || !name || amount == null) return null;
  return { id, name, amount, unit };
}

function normalizeNutrientFromDetail(raw: RawFoodNutrient): FoodNutrient | null {
  // Detail responses nest nutrient info under `nutrient` sub-object
  const id = raw.nutrient?.id ?? raw.nutrientId;
  const name = (raw.nutrient?.name ?? raw.nutrientName)?.trim();
  const number = (raw.nutrient?.number ?? raw.nutrientNumber)?.trim() ?? '';
  const unit = (raw.nutrient?.unitName ?? raw.unitName)?.trim() ?? '';
  const amount = raw.amount ?? raw.value;
  if (id == null || !name || amount == null) return null;
  return {
    id,
    name,
    number,
    amount,
    unit,
    ...(raw.percentDailyValue != null && { percentDailyValue: raw.percentDailyValue }),
  };
}

function normalizePortion(raw: RawFoodPortion): FoodPortion | null {
  if (raw.gramWeight == null || raw.gramWeight <= 0) return null;
  const parts: string[] = [];
  if (raw.portionDescription?.trim()) parts.push(raw.portionDescription.trim());
  if (raw.modifier?.trim()) parts.push(raw.modifier.trim());
  if (raw.measureUnit?.name?.trim()) parts.push(raw.measureUnit.name.trim());
  const description = parts.join(' ') || 'Serving';
  return { description, gramWeight: raw.gramWeight };
}

function normalizeFoodCategory(
  raw: string | { description?: string } | undefined,
): string | undefined {
  if (!raw) return;
  if (typeof raw === 'string') return raw.trim() || undefined;
  return raw.description?.trim() || undefined;
}

function normalizeSearchFood(raw: RawSearchFood): SearchResultFood {
  const nutrients = (raw.foodNutrients ?? [])
    .map(normalizeNutrientFromSearch)
    .filter((n): n is NonNullable<typeof n> => n !== null);

  return {
    fdcId: raw.fdcId,
    description: raw.description,
    dataType: raw.dataType ?? 'Unknown',
    nutrients,
    ...(raw.foodCategory && { foodCategory: raw.foodCategory }),
    ...(raw.brandOwner && { brandOwner: raw.brandOwner }),
    ...(raw.brandName && { brandName: raw.brandName }),
    ...(raw.servingSize != null && { servingSize: raw.servingSize }),
    ...(raw.servingSizeUnit && { servingSizeUnit: raw.servingSizeUnit }),
    ...(raw.householdServingFullText && { householdServingFullText: raw.householdServingFullText }),
    ...(raw.publishedDate && { publishedDate: raw.publishedDate }),
  };
}

/**
 * Applies the caller's nutrient filter locally, by FDC nutrient id.
 *
 * The filter is never forwarded to FDC: its `nutrients` parameter matches SR
 * *numbers* (`"208"`), while every id this server hands out and accepts is an
 * FDC nutrient *id* (`1008`). Sending ids upstream returns an empty
 * `foodNutrients[]`, so the full profile is fetched and narrowed here instead.
 */
function normalizeFoodDetail(raw: RawFoodDetail, nutrientFilter?: number[]): FoodDetail {
  const allNutrients = (raw.foodNutrients ?? [])
    .map(normalizeNutrientFromDetail)
    .filter((n): n is FoodNutrient => n !== null);

  const nutrients =
    nutrientFilter && nutrientFilter.length > 0
      ? allNutrients.filter((n) => nutrientFilter.includes(n.id))
      : allNutrients;

  const portions = (raw.foodPortions ?? [])
    .map(normalizePortion)
    .filter((p): p is FoodPortion => p !== null);

  const category = normalizeFoodCategory(raw.foodCategory);
  return {
    fdcId: raw.fdcId,
    description: raw.description,
    dataType: raw.dataType ?? 'Unknown',
    nutrients,
    portions,
    ...(category && { foodCategory: category }),
    ...(raw.publicationDate && { publicationDate: raw.publicationDate }),
    ...(raw.brandOwner && { brandOwner: raw.brandOwner }),
    ...(raw.brandName && { brandName: raw.brandName }),
    ...(raw.ingredients && { ingredients: raw.ingredients }),
  };
}

// ---- Search query escaping ----

/** Lucene's token separators: what its classic query parser skips between terms. */
function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '　';
}

/** Besides whitespace, the characters a regex or range term may follow: a group, an operator, a `field:` colon. */
const TERM_PREFIXES = new Set(['(', '+', '-', '!', ':']);
/** Besides whitespace, the characters that may follow a regex or range term: a group close, a boost, a fuzzy slop. */
const TERM_SUFFIXES = new Set([')', '^', '~']);
const RANGE_DELIMITERS = new Set(['[', ']', '{', '}']);

function endsTerm(query: string, index: number): boolean {
  const char = query.charAt(index);
  return index >= query.length || isWhitespace(char) || TERM_SUFFIXES.has(char);
}

/**
 * End (exclusive) of the well-formed `/regex/` term opening at `start`, or -1.
 * The scan stops at the first unescaped `/` or whitespace, so it never crosses
 * another regex opener.
 */
function regexEnd(query: string, start: number): number {
  for (let i = start + 1; i < query.length; i++) {
    const char = query.charAt(i);
    if (char === '\\') i++;
    else if (char === '/') return endsTerm(query, i + 1) ? i + 1 : -1;
    else if (isWhitespace(char)) return -1;
  }
  return -1;
}

/** End of a range bound starting at `index`: escape pairs included, stopping at whitespace or any bracket or brace. */
function boundEnd(query: string, index: number): number {
  let i = index;
  while (i < query.length) {
    const char = query.charAt(i);
    if (isWhitespace(char) || RANGE_DELIMITERS.has(char)) break;
    i += char === '\\' ? 2 : 1;
  }
  return Math.min(i, query.length);
}

function whitespaceEnd(query: string, index: number): number {
  let i = index;
  while (i < query.length && isWhitespace(query.charAt(i))) i++;
  return i;
}

/**
 * End (exclusive) of the well-formed `[low TO high]` range term opening at
 * `start` (either side may be `{`/`}`, either bound `*`), or -1. Bounds hold no
 * bracket or brace, so the scan never crosses another range opener.
 */
function rangeEnd(query: string, start: number): number {
  const lowerEnd = boundEnd(query, start + 1);
  if (lowerEnd === start + 1) return -1;
  const toStart = whitespaceEnd(query, lowerEnd);
  if (toStart === lowerEnd || !query.startsWith('TO', toStart)) return -1;
  const upperStart = whitespaceEnd(query, toStart + 2);
  if (upperStart === toStart + 2) return -1;
  const upperEnd = boundEnd(query, upperStart);
  if (upperEnd === upperStart) return -1;
  const closer = query.charAt(upperEnd);
  return (closer === ']' || closer === '}') && endsTerm(query, upperEnd + 1) ? upperEnd + 1 : -1;
}

/**
 * Escapes the characters FDC's Lucene query parser rejects with a bare 400 and
 * leaves everything that already works untouched. Escaped: each `/`, `[`, `]`,
 * `{`, `}` outside a well-formed regex or range term; every `"` when the
 * unescaped count is odd; and each `(` or `)` that pairs with nothing by depth
 * (`)(` does not pair).
 *
 * A regex term is a `/…/` pair whose opener begins a term (at the start, after
 * whitespace, `(`, `+`, `-`, `!`, or a `field:` colon), whose closer ends one
 * (before the end, whitespace, `)`, `^`, or `~`), and whose body holds no
 * unescaped whitespace or `/`: `/chick.+/`, `description:/chick.+/`. A range
 * term opens with `[` or `{` at a term start, holds a whitespace-free lower
 * bound, `TO`, and a whitespace-free upper bound, and closes with `]` or `}`
 * at a term end: `[a TO c]`, `{* TO 5}`. Both pass through whole, so
 * `w/o salt`, `trimmed to 1/8" fat`, `beef 1/8 cooked 1/4`, and `beef [raw]`
 * search literally while regex and range queries keep working.
 *
 * Text inside a balanced quoted phrase is literal to Lucene and is left alone.
 * Quoted phrases, `+`/`-`/`!`, `AND`/`OR`/`NOT`/`&&`/`||`, `*`/`?`, `~`, `^`,
 * balanced groups, and `field:` prefixes pass through.
 *
 * A `\` and the character after it are one escape pair and pass through as
 * written, so nothing is double-escaped. A trailing lone `\` is sent as-is:
 * FDC rejects it, and the `query_syntax` recovery names it, rather than this
 * function guessing whether a literal backslash was meant.
 *
 * Linear in UTF-16 code units — no regex. Each term scan stops at the next
 * opener of its own kind, so no character is rescanned by more than one regex
 * scan and one range scan.
 */
export function escapeFdcQuery(query: string): string {
  const length = query.length;

  let quotes = 0;
  for (let i = 0; i < length; i++) {
    const char = query.charAt(i);
    if (char === '\\') i++;
    else if (char === '"') quotes++;
  }
  const quotesBalanced = quotes % 2 === 0;

  const needsEscape = new Uint8Array(length);
  const openers: number[] = [];
  let inPhrase = false;
  /** Whether the character at `i` may begin a regex or range term. */
  let termStart = true;
  for (let i = 0; i < length; i++) {
    const char = query.charAt(i);
    let nextStartsTerm = false;
    if (char === '\\') {
      i++;
    } else if (char === '"') {
      if (quotesBalanced) inPhrase = !inPhrase;
      else needsEscape[i] = 1;
    } else if (inPhrase) {
      // Literal phrase text.
    } else if (char === '/' || char === '[' || char === '{') {
      const end = termStart ? (char === '/' ? regexEnd(query, i) : rangeEnd(query, i)) : -1;
      if (end === -1) needsEscape[i] = 1;
      else i = end - 1;
    } else if (char === ']' || char === '}') {
      needsEscape[i] = 1;
    } else if (char === '(') {
      openers.push(i);
      nextStartsTerm = true;
    } else if (char === ')') {
      if (openers.pop() === undefined) needsEscape[i] = 1;
    } else {
      nextStartsTerm = isWhitespace(char) || TERM_PREFIXES.has(char);
    }
    termStart = nextStartsTerm;
  }
  for (const index of openers) needsEscape[index] = 1;

  let out = '';
  let copiedTo = 0;
  for (let i = 0; i < length; i++) {
    if (needsEscape[i] === 1) {
      out += `${query.slice(copiedTo, i)}\\`;
      copiedTo = i;
    }
  }
  return out + query.slice(copiedTo);
}

// ---- Request helper ----

/**
 * One FDC call, retried as a single ladder: `TIMEOUT_MS` per attempt, up to 3
 * retries with exponential backoff, all inside a `DEADLINE_MS` wall-clock
 * budget that also covers every honored `Retry-After`. Every tool and resource
 * makes exactly one call, so the budget bounds the whole tool call and its
 * typed error lands before a 60 s client timeout does. Both POST endpoints are
 * reads, so retrying them is safe.
 *
 * @throws `Timeout` with `data.reason: 'retry_deadline_exceeded'` when the
 *   budget runs out — or that attempt's `RateLimited` error when the last
 *   attempt to complete before the cut-off was a 429, since "wait and call
 *   again" is then the caller's real next move.
 */
async function fetchFdc<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST';
    body?: unknown;
    ctx: Context;
    /**
     * Non-2xx statuses this caller treats as a routine outcome. A listed status
     * logs at `debug` instead of `error`; the thrown, status-mapped `McpError`
     * is unchanged, so every declared error contract still behaves identically.
     */
    expectedStatuses?: number[];
  },
): Promise<T> {
  const apiKey = getServerConfig().fdcApiKey;
  const url = new URL(`${BASE_URL}${path}`);
  /**
   * The deadline's expiry carries the cut-off attempt as its `cause`, which
   * never reaches the wire — so a ladder ending in slow 429s would read as an
   * outage. Holds the latest completed attempt's 429, cleared by any other outcome.
   */
  let lastRateLimit: McpError | undefined;

  try {
    return await withRetry(
      async ({ signal }) => {
        try {
          // fetchWithTimeout throws a status-mapped McpError on every non-2xx.
          const response = await fetchWithTimeout(url.toString(), TIMEOUT_MS, options.ctx, {
            method: options.method ?? 'GET',
            headers: {
              'Content-Type': 'application/json',
              'X-Api-Key': apiKey,
            },
            ...(options.body != null && { body: JSON.stringify(options.body) }),
            // The attempt signal composes ctx.signal with the deadline clock.
            signal,
            ...(options.expectedStatuses && { expectedStatuses: options.expectedStatuses }),
          });

          const text = await response.text();
          if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
            throw serviceUnavailable(
              'USDA FDC API returned HTML instead of JSON — likely rate-limited.',
            );
          }

          return JSON.parse(text) as T;
        } catch (error) {
          // Track the latest completed attempt only; one the deadline cut off leaves it as it was.
          if (!signal.aborted) {
            lastRateLimit =
              error instanceof McpError && error.code === JsonRpcErrorCode.RateLimited
                ? error
                : undefined;
          }
          throw error;
        }
      },
      {
        operation: `FdcService${path}`,
        context: options.ctx,
        baseDelayMs: 1000,
        signal: options.ctx.signal,
        deadlineMs: DEADLINE_MS,
      },
    );
  } catch (error) {
    if (
      lastRateLimit &&
      error instanceof McpError &&
      error.data?.reason === 'retry_deadline_exceeded'
    ) {
      throw lastRateLimit;
    }
    throw error;
  }
}

// ---- Service class ----

export class FdcService {
  /**
   * Search foods by keyword.
   */
  async searchFoods(
    params: {
      query: string;
      dataType?: FdcDataType[];
      brandOwner?: string;
      foodCategory?: string;
      pageSize?: number;
      pageNumber?: number;
    },
    ctx: Context,
  ): Promise<{
    totalHits: number;
    currentPage: number;
    totalPages: number;
    foods: SearchResultFood[];
  }> {
    const fdcQuery = escapeFdcQuery(params.query);
    ctx.log.debug('Searching FDC foods', {
      query: params.query,
      fdcQuery,
      dataType: params.dataType,
    });

    const body: Record<string, unknown> = {
      query: fdcQuery,
      pageSize: params.pageSize ?? 10,
      pageNumber: params.pageNumber ?? 1,
    };
    if (params.dataType?.length) body.dataType = params.dataType;
    if (params.brandOwner?.trim()) body.brandOwner = params.brandOwner.trim();
    if (params.foodCategory?.trim()) body.foodCategory = params.foodCategory.trim();

    let raw: RawSearchResponse;
    try {
      /**
       * A 400 here is FDC's Lucene parser refusing the query — a caller-input
       * outcome declared as `query_syntax`, so it logs at `debug`.
       */
      raw = await fetchFdc<RawSearchResponse>('/foods/search', {
        method: 'POST',
        body,
        ctx,
        expectedStatuses: [400],
      });
    } catch (error) {
      if (error instanceof McpError && error.data?.status === 400) {
        throw validationError(
          `FDC rejected the query syntax of "${params.query}".`,
          { reason: 'query_syntax', query: params.query },
          { cause: error },
        );
      }
      throw error;
    }

    return {
      totalHits: raw.totalHits ?? 0,
      currentPage: raw.currentPage ?? 1,
      totalPages: raw.totalPages ?? 1,
      foods: (raw.foods ?? []).map(normalizeSearchFood),
    };
  }

  /**
   * Fetch full nutrient detail for a single food by FDC ID.
   */
  async getFoodDetail(
    fdcId: number,
    nutrientFilter: number[] | undefined,
    ctx: Context,
  ): Promise<FoodDetail> {
    ctx.log.debug('Fetching FDC food detail', { fdcId });

    /**
     * A 404 here is the declared `not_found` outcome for a caller-supplied id,
     * not a server fault, so it logs at `debug`. This is the only FDC path that
     * 404s on a bad id — `/foods` omits it from a 200, and `/foods/search`
     * answers 200 with `totalHits: 0` — so a 404 anywhere else stays an error.
     */
    const raw = await fetchFdc<RawFoodDetail>(`/food/${fdcId}`, {
      ctx,
      expectedStatuses: [404],
    });

    return normalizeFoodDetail(raw, nutrientFilter);
  }

  /**
   * Batch fetch nutrient profiles for multiple foods (up to 20 IDs).
   * Returns per-food results and a list of IDs that failed.
   */
  async getFoodsBatch(
    fdcIds: number[],
    nutrientFilter: number[] | undefined,
    ctx: Context,
  ): Promise<{
    foods: FoodDetail[];
    failed: Array<{ fdcId: number; error: string }>;
  }> {
    ctx.log.debug('Fetching FDC batch foods', { count: fdcIds.length });

    // format:"abridged" returns empty foodNutrients[] — do not use
    const rawList = await fetchFdc<RawFoodDetail[]>('/foods', {
      method: 'POST',
      body: { fdcIds },
      ctx,
    });

    const returnedMap = new Map<number, RawFoodDetail>();
    for (const item of rawList) {
      if (item.fdcId) returnedMap.set(item.fdcId, item);
    }

    const foods: FoodDetail[] = [];
    const failed: Array<{ fdcId: number; error: string }> = [];

    for (const id of fdcIds) {
      const raw = returnedMap.get(id);
      if (!raw) {
        failed.push({ fdcId: id, error: `FDC ID ${id} not found or returned no data.` });
      } else {
        foods.push(normalizeFoodDetail(raw, nutrientFilter));
      }
    }

    return { foods, failed };
  }
}

// ---- Init/accessor pattern ----

let _service: FdcService | undefined;

export function initFdcService(): void {
  _service = new FdcService();
}

export function getFdcService(): FdcService {
  if (!_service) {
    throw new Error('FdcService not initialized — call initFdcService() in setup()');
  }
  return _service;
}
