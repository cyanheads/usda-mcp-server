/**
 * @fileoverview USDA FoodData Central API service — search, single-food fetch, and batch fetch.
 * @module services/fdc/fdc-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  defaultIsTransient,
  fetchWithTimeout,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { basisUnitFor } from './basis.js';
import { nutrientProvenance } from './provenance.js';
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
/**
 * How long one attempt of a search page or a multi-ID `/foods` batch may wait
 * for response headers, and then again for the body once they arrive.
 */
const TIMEOUT_MS = 15_000;
/**
 * One tool call's budget across every FDC request it makes — each attempt,
 * backoff, honored Retry-After, and per-ID refetch — so its typed error lands
 * before a 60 s client timeout does.
 */
const DEADLINE_MS = 45_000;
/**
 * Search preview only. Distinct measures keep their own IDs: four energy
 * estimates, and fiber as 1079 and as 2033 (AOAC 2011.25), a different method
 * that reads higher on every record reporting both, so neither stands in for
 * the other.
 */
const SEARCH_NUTRIENT_IDS = new Set([1003, 1004, 1005, 1079, 2033, 1008, 1062, 2047, 2048]);

/**
 * The deepest result `/foods/search` serves: FDC answers HTTP 400 to any page
 * whose `pageSize × pageNumber` exceeds it, however many foods match.
 */
export const FDC_RESULT_WINDOW = 100_000;

/** The most rows one `/foods/search` page holds: FDC answers HTTP 400 to a larger `pageSize`. */
export const FDC_MAX_PAGE_SIZE = 200;

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

/**
 * The four units detail and batch records spell differently from search and
 * the nutrient reference, keyed by the detail spelling; every other unit, `IU`
 * and `kJ` included, is spelled the same on both and passes through. A table,
 * never `toUpperCase()`: the micro sign FDC sends (U+00B5) uppercases to a
 * Greek capital mu, not `U`.
 */
const SEARCH_UNIT_SPELLING = new Map([
  ['g', 'G'],
  ['mg', 'MG'],
  ['\u{00B5}g', 'UG'],
  ['kcal', 'KCAL'],
]);

/**
 * One detail or batch nutrient row, or null when it lacks an id, name, or
 * amount. FDC's provenance fields ride it only when `provenance` is set:
 * `usda://food/{fdcId}` returns the normalized record as-is and usda_get_food
 * spreads each nutrient into its output, so a field attached by default would
 * reach both.
 */
function normalizeNutrientFromDetail(
  raw: RawFoodNutrient,
  provenance: boolean,
): FoodNutrient | null {
  // Detail responses nest nutrient info under `nutrient` sub-object
  const id = raw.nutrient?.id ?? raw.nutrientId;
  const name = (raw.nutrient?.name ?? raw.nutrientName)?.trim();
  const number = (raw.nutrient?.number ?? raw.nutrientNumber)?.trim() ?? '';
  const sentUnit = (raw.nutrient?.unitName ?? raw.unitName)?.trim() ?? '';
  const unit = SEARCH_UNIT_SPELLING.get(sentUnit) ?? sentUnit;
  const amount = raw.amount ?? raw.value;
  if (id == null || !name || amount == null) return null;
  return {
    id,
    name,
    number,
    amount,
    unit,
    ...(raw.percentDailyValue != null && { percentDailyValue: raw.percentDailyValue }),
    ...(provenance && nutrientProvenance(raw)),
  };
}

/**
 * How a measure-unit name reads in a portion description, where that differs
 * from the name: FDC's placeholder (`undetermined`, id 9999) reads as nothing
 * and `RACC` is spelled out.
 */
const MEASURE_UNIT_TEXT = new Map([
  ['undetermined', ''],
  ['RACC', 'RACC (reference amount customarily consumed)'],
]);

/**
 * One description rule for every data type: FNDDS's `portionDescription` as
 * sent, since it already carries the amount; otherwise the amount, the measure
 * unit (FDC's placeholder dropped), and the modifier (FNDDS's all-digit food
 * codes dropped), space-joined; `Serving` when nothing remains.
 */
function describePortion(raw: RawFoodPortion, amount: number | undefined): string {
  const described = raw.portionDescription?.trim();
  if (described) return described;
  const unit = raw.measureUnit?.name?.trim() ?? '';
  const modifier = raw.modifier?.trim() ?? '';
  const parts = [
    amount === undefined ? '' : String(amount),
    MEASURE_UNIT_TEXT.get(unit) ?? unit,
    /^\d+$/.test(modifier) ? '' : modifier,
  ];
  return parts.filter(Boolean).join(' ') || 'Serving';
}

function normalizePortion(raw: RawFoodPortion): FoodPortion | null {
  if (raw.gramWeight == null || raw.gramWeight <= 0) return null;
  const amount =
    raw.amount != null && Number.isFinite(raw.amount) && raw.amount > 0 ? raw.amount : undefined;
  return {
    description: describePortion(raw, amount),
    gramWeight: raw.gramWeight,
    ...(amount !== undefined && { amount }),
  };
}

/**
 * FDC's display order for portions, which arrive in no fixed order: ascending
 * `sequenceNumber`, which FDC's data dictionary defines as the order a portion
 * is displayed in, with unnumbered portions after the numbered ones. Equal keys
 * compare 0, so the stable sort keeps FDC's array order for ties.
 */
function bySequence(a: RawFoodPortion, b: RawFoodPortion): number {
  const x = a.sequenceNumber ?? Number.POSITIVE_INFINITY;
  const y = b.sequenceNumber ?? Number.POSITIVE_INFINITY;
  return x === y ? 0 : x < y ? -1 : 1;
}

/**
 * FDC files a record's category under a different field per data type: SR
 * Legacy and Foundation send `foodCategory`, Branded `brandedFoodCategory`,
 * and Survey (FNDDS) `wweiaFoodCategory`. The first non-blank one, trimmed.
 */
function normalizeFoodCategory(raw: RawFoodDetail): string | undefined {
  const category =
    typeof raw.foodCategory === 'string' ? raw.foodCategory : raw.foodCategory?.description;
  return [category, raw.brandedFoodCategory, raw.wweiaFoodCategory?.wweiaFoodCategoryDescription]
    .map((value) => value?.trim())
    .find((value) => !!value);
}

function normalizeSearchFood(raw: RawSearchFood): SearchResultFood {
  const nutrients = (raw.foodNutrients ?? [])
    .map(normalizeNutrientFromSearch)
    .filter((n): n is NonNullable<typeof n> => n !== null && SEARCH_NUTRIENT_IDS.has(n.id));

  const dataType = raw.dataType ?? 'Unknown';
  const basisUnit = basisUnitFor(dataType, raw.servingSizeUnit);
  return {
    fdcId: raw.fdcId,
    description: raw.description,
    dataType,
    ...(basisUnit && { basisUnit }),
    nutrients,
    ...(raw.foodCategory && { foodCategory: raw.foodCategory }),
    ...(raw.brandOwner && { brandOwner: raw.brandOwner }),
    ...(raw.brandName && { brandName: raw.brandName }),
    ...(raw.gtinUpc && { gtinUpc: raw.gtinUpc }),
    ...(raw.servingSize != null && { servingSize: raw.servingSize }),
    ...(raw.servingSizeUnit && { servingSizeUnit: raw.servingSizeUnit }),
    ...(raw.householdServingFullText && { householdServingFullText: raw.householdServingFullText }),
    ...(raw.publishedDate && { publishedDate: raw.publishedDate }),
  };
}

/** The date shape detail and batch records carry, `M/D/YYYY` unpadded (`4/1/2019`). */
const FDC_DETAIL_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** Days in each month of a leap year. */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isCalendarDate(year: number, month: number, day: number): boolean {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 && !leap ? 28 : MONTH_DAYS[month - 1];
  return days !== undefined && day >= 1 && day <= days;
}

/**
 * A detail `publicationDate` in search's zero-padded `YYYY-MM-DD` form. Only
 * the `M/D/YYYY` shape converts, matched exactly rather than through
 * `Date.parse`, which accepts other shapes and reads them by locale. Any other
 * shape, and a date in that shape that names no calendar day (`13/45/2020`,
 * `2/30/2021`), passes through as sent, never as a date FDC did not state.
 */
function normalizePublicationDate(date: string): string {
  return date.replace(FDC_DETAIL_DATE, (sent, month: string, day: string, year: string) =>
    isCalendarDate(Number(year), Number(month), Number(day))
      ? `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
      : sent,
  );
}

/**
 * Applies the caller's nutrient filter locally, by FDC nutrient id, and names
 * the requested ids the food's profile does not report — deduplicated, in
 * request order — as `missingNutrients`.
 *
 * The filter is never forwarded to FDC: its `nutrients` parameter matches SR
 * *numbers* (`"208"`), while every id this server hands out and accepts is an
 * FDC nutrient *id* (`1008`). Sending ids upstream returns an empty
 * `foodNutrients[]`, so the full profile is fetched and narrowed here instead.
 */
function normalizeFoodDetail(
  raw: RawFoodDetail,
  nutrientFilter: number[] | undefined,
  provenance = false,
): FoodDetail {
  const allNutrients = (raw.foodNutrients ?? [])
    .map((n) => normalizeNutrientFromDetail(n, provenance))
    .filter((n): n is FoodNutrient => n !== null);

  const requested = nutrientFilter?.length ? new Set(nutrientFilter) : undefined;
  const nutrients = requested ? allNutrients.filter((n) => requested.has(n.id)) : allNutrients;
  const reported = new Set(nutrients.map((n) => n.id));
  const missingNutrients = requested ? [...requested].filter((id) => !reported.has(id)) : [];

  // Every consumer (servingInfo, allPortions, serving scaling, the resource) reads this order.
  const portions = (raw.foodPortions ?? [])
    .toSorted(bySequence)
    .map(normalizePortion)
    .filter((p): p is FoodPortion => p !== null);

  const dataType = raw.dataType ?? 'Unknown';
  const basisUnit = basisUnitFor(dataType, raw.servingSizeUnit);
  const category = normalizeFoodCategory(raw);
  return {
    fdcId: raw.fdcId,
    description: raw.description,
    dataType,
    ...(basisUnit && { basisUnit }),
    nutrients,
    ...(missingNutrients.length > 0 && { missingNutrients }),
    portions,
    ...(category && { foodCategory: category }),
    ...(raw.publicationDate && { publicationDate: normalizePublicationDate(raw.publicationDate) }),
    ...(raw.brandOwner && { brandOwner: raw.brandOwner }),
    ...(raw.brandName && { brandName: raw.brandName }),
    ...(raw.gtinUpc && { gtinUpc: raw.gtinUpc }),
    ...(raw.ingredients && { ingredients: raw.ingredients }),
    ...(raw.servingSize != null && { servingSize: raw.servingSize }),
    ...(raw.servingSizeUnit && { servingSizeUnit: raw.servingSizeUnit }),
    ...(raw.householdServingFullText && { householdServingFullText: raw.householdServingFullText }),
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

/**
 * Encodes a `brandOwner` or `foodCategory` filter for `/foods/search`. FDC
 * parses each as a Lucene query that ORs its words, so the value goes as one
 * quoted phrase, `\` and `"` escaped in a single pass, and matches records
 * holding it contiguously (FDC ignores case and punctuation within it). A
 * value holding `*` or `?` is a wildcard pattern, which a phrase cannot carry,
 * so it is sent as written.
 */
export function encodeFdcFilter(value: string): string {
  if (isWildcardFilter(value)) return value;
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

/** Whether a `brandOwner` or `foodCategory` value is a wildcard pattern (holds `*` or `?`), sent to FDC as written. */
export function isWildcardFilter(value: string): boolean {
  return value.includes('*') || value.includes('?');
}

// ---- Request helper ----

/**
 * One tool call's FDC budget, shared by every request the call makes: one
 * {@link DEADLINE_MS} clock, and what the call's attempts have seen so far.
 */
interface FdcBudget {
  /** Upstream requests the call has sent, retries included. */
  attempts: number;
  /** Epoch ms when the budget runs out. */
  readonly deadlineAt: number;
  /**
   * The 429 of the call's latest completed attempt, cleared by a completed
   * attempt that failed any other way. A deadline's expiry carries the cut-off
   * attempt as its `cause`, which never reaches the wire, so a call ending in
   * slow 429s would otherwise read as an outage.
   */
  lastRateLimit: McpError | undefined;
}

function startBudget(): FdcBudget {
  return { deadlineAt: Date.now() + DEADLINE_MS, attempts: 0, lastRateLimit: undefined };
}

/** `withRetry`'s expiry: a ladder that ran out of budget. */
function isDeadlineExpiry(error: unknown): boolean {
  return error instanceof McpError && error.data?.reason === 'retry_deadline_exceeded';
}

/**
 * What a call reports when its budget ran out: the latest completed attempt's
 * 429 when it was one, since "wait and call again" is then the caller's real
 * next move; any other error unchanged.
 */
function reportDeadline(budget: FdcBudget, error: unknown): unknown {
  return budget.lastRateLimit && isDeadlineExpiry(error) ? budget.lastRateLimit : error;
}

/**
 * A failure the ladder retries and a later call can clear — a 5xx, a 429, a
 * network error, an attempt timeout, or the deadline's expiry: every `McpError`
 * {@link defaultIsTransient} accepts. A thrown non-`McpError` is a bug, not
 * slowness, and a body FDC should never send carries `retryable: false`.
 */
function isTransientFailure(error: unknown): boolean {
  return error instanceof McpError && defaultIsTransient(error);
}

/**
 * An attempt its own {@link TIMEOUT_MS} bound cut, waiting for headers or for
 * the body after them — neither the deadline nor the caller.
 */
function isAttemptTimeout(error: unknown): boolean {
  return (
    error instanceof McpError &&
    error.code === JsonRpcErrorCode.Timeout &&
    error.data?.errorSource === 'AttemptTimeout'
  );
}

/**
 * One FDC request, retried as a single ladder: up to 3 retries with
 * exponential backoff inside what remains of the call's budget, which also
 * covers every honored `Retry-After`. `request` sets how long one attempt may
 * run:
 *
 * - omitted — a search page: each attempt waits up to {@link TIMEOUT_MS} for
 *   headers, then up to `TIMEOUT_MS` more for the body, and an attempt either
 *   bound cuts is retried.
 * - `'batch'` — several IDs from `/foods`: the same two bounds, and a cut
 *   attempt is thrown at once rather than retried, for the caller to split per
 *   ID ({@link fetchEachId}). FDC builds the whole response before sending a
 *   byte, so a retry would only start the same wait over; once headers arrive
 *   the response is built, and its body gets a bound of its own.
 * - `'record'` — one food: an attempt runs until the call's deadline. One
 *   record can take longer than `TIMEOUT_MS` to build, and retrying it only
 *   restarts the build.
 *
 * Fast transient failures (5xx, 429, network) retry under every kind. Both
 * POST endpoints are reads, so retrying them is safe.
 *
 * @throws `Timeout` with `data.reason: 'retry_deadline_exceeded'` when the
 *   budget runs out. A request given no `budget` is the whole call and reports
 *   that through {@link reportDeadline}; a shared budget's owner reports it.
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
    request?: 'batch' | 'record';
    /** The call's budget when it makes more than this one request. */
    budget?: FdcBudget;
    /**
     * What cancels the ladder, in place of `ctx.signal`: a split's refetches
     * pass `ctx.signal` joined with the split's own stop.
     */
    signal?: AbortSignal;
  },
): Promise<T> {
  const budget = options.budget ?? startBudget();
  const apiKey = getServerConfig().fdcApiKey;
  const url = new URL(`${BASE_URL}${path}`);

  try {
    return await withRetry(
      async ({ signal }) => {
        budget.attempts++;
        // A record has no bound of its own: the deadline ends its attempt.
        const bound = options.request === 'record' ? undefined : new AbortController();
        /**
         * The bound aborts with the default `AbortError`, never a
         * `TimeoutError`: `fetchWithTimeout` logs a `TimeoutError` on its
         * signal at `error`, as a caller-side deadline, which every batch that
         * splits would then write. It logs any other abort at `info`.
         */
        const arm = () => bound && setTimeout(() => bound.abort(), TIMEOUT_MS);
        let timer = arm();
        let phase: 'headers' | 'body' = 'headers';
        try {
          /**
           * fetchWithTimeout throws a status-mapped McpError on every non-2xx.
           * Its own timer, which covers the body too, is set to the deadline,
           * so the deadline clock always fires first.
           */
          const response = await fetchWithTimeout(url.toString(), DEADLINE_MS, options.ctx, {
            method: options.method ?? 'GET',
            headers: {
              'Content-Type': 'application/json',
              'X-Api-Key': apiKey,
            },
            ...(options.body != null && { body: JSON.stringify(options.body) }),
            /**
             * `signal` joins the ladder's cancellation with the deadline clock.
             * The bound joins here only: as `withRetry`'s signal, its expiry
             * would read as a cancellation, never retried.
             */
            signal: bound ? AbortSignal.any([signal, bound.signal]) : signal,
            ...(options.expectedStatuses && { expectedStatuses: options.expectedStatuses }),
          });

          // The response is built once headers arrive; the body gets a bound of its own.
          clearTimeout(timer);
          timer = arm();
          phase = 'body';
          const text = await response.text();
          if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
            throw serviceUnavailable(
              'USDA FDC API returned HTML instead of JSON — likely rate-limited.',
            );
          }

          try {
            return JSON.parse(text) as T;
          } catch (parseError) {
            // A complete body that isn't JSON answers the same way again, so it isn't retried.
            throw serviceUnavailable(
              'USDA FDC API returned a response body that is not JSON.',
              { retryable: false },
              { cause: parseError },
            );
          }
        } catch (caught) {
          // The bound's expiry reaches here as a cancellation; it is reported as the attempt's own timeout.
          const error =
            !signal.aborted && bound?.signal.aborted
              ? timeout(
                  phase === 'headers'
                    ? `FDC ${path} attempt was not answered within ${TIMEOUT_MS}ms.`
                    : `FDC ${path} attempt's response body did not finish within ${TIMEOUT_MS}ms of its headers.`,
                  { errorSource: 'AttemptTimeout' },
                )
              : caught;
          // Track completed attempts only; one the deadline cut off leaves the record as it was.
          if (!signal.aborted) {
            budget.lastRateLimit =
              error instanceof McpError && error.code === JsonRpcErrorCode.RateLimited
                ? error
                : undefined;
          }
          throw error;
        } finally {
          clearTimeout(timer);
        }
      },
      {
        operation: `FDC ${path} request`,
        context: options.ctx,
        baseDelayMs: 1000,
        signal: options.signal ?? options.ctx.signal,
        deadlineMs: budget.deadlineAt - Date.now(),
        ...(options.request === 'batch' && {
          isTransient: (error: unknown) => !isAttemptTimeout(error) && defaultIsTransient(error),
        }),
      },
    );
  } catch (error) {
    throw options.budget ? error : reportDeadline(budget, error);
  }
}

/**
 * The `/foods` batch body as a list. FDC answers HTTP 200 `{}` rather than
 * `[]` when it knows none of the requested IDs, so an empty object reads as
 * zero matches.
 *
 * @throws `ServiceUnavailable` for any other non-array body.
 */
function batchFoodList(body: unknown): RawFoodDetail[] {
  if (Array.isArray(body)) return body as RawFoodDetail[];
  if (typeof body === 'object' && body !== null && Object.keys(body).length === 0) return [];
  // A complete body of the wrong shape answers the same way again, so a split never defers it.
  throw serviceUnavailable(
    'USDA FDC /foods returned an unexpected response body instead of a list of foods.',
    { retryable: false },
  );
}

/**
 * Every per-ID refetch in this process waits here for one of 10 slots, so
 * concurrent calls splitting their batches never put more than 10 single-ID
 * requests in flight between them. A refetch holds its slot for its whole
 * ladder. With no rate windows the pacer arms no timer, so it needs no disposal.
 */
const singleIdPacer = createPacer({ name: 'fdc-single-id', maxConcurrent: 10 });

/**
 * Refetches each of `ids` as its own `{ fdcIds: [id] }` record request, after
 * a batch attempt ran out of time. All start at once through
 * {@link singleIdPacer} and share `budget`'s deadline. An ID FDC has not
 * answered when the deadline lands — in flight, retrying, or still queued for
 * a slot, and then never sent — comes back in `deferredIds`, in `ids` order,
 * and so does one whose ladder ended on a transient failure
 * ({@link isTransientFailure}): retries run out, or a Retry-After past the budget.
 *
 * @throws The caller's abort reason once `ctx.signal` fires, never a partial result.
 * @throws The first refetch failure to arrive that is not transient — a 3xx, a
 *   4xx other than 408, 425, or 429, a 501, a 200 body that is not JSON or not
 *   a list of foods, or a non-`McpError` — the moment it arrives. It ends the
 *   split: queued IDs are never sent, refetches in flight are aborted, and
 *   foods already answered are discarded.
 * @throws When no ID was answered, the first failure in `ids` order the
 *   deadline did not cause; failing that, `Timeout` (`retry_deadline_exceeded`)
 *   naming the whole budget, or that 429 per {@link reportDeadline}.
 */
async function fetchEachId(
  ids: number[],
  budget: FdcBudget,
  ctx: Context,
): Promise<{ records: RawFoodDetail[]; deferredIds: number[] }> {
  // A refetch the deadline stopped before it was sent settles with this, matched by identity.
  const unsent = new DOMException(
    'The FDC call budget ran out before this request was sent.',
    'TimeoutError',
  );
  const clock = new AbortController();
  const timer = setTimeout(() => clock.abort(unsent), budget.deadlineAt - Date.now());
  /**
   * This split's own stop, fired by its first refetch failure that is not
   * transient. It reaches this split's queue and refetch ladders only, never
   * `ctx.signal`, another call's split, or the shared pacer, so the slots it
   * frees go straight to whoever is waiting.
   */
  const stop = new AbortController();
  let fatal: unknown;
  // A queued refetch leaves the line when the caller aborts, the deadline lands, or the split stops.
  const queueSignal = AbortSignal.any([ctx.signal, clock.signal, stop.signal]);
  /**
   * The deadline stays off a refetch's ladder signal: its own clock reports
   * the deadline as `retry_deadline_exceeded`, where this signal firing would
   * surface a `FetchSignalTimeout`, which is not transient.
   */
  const refetchSignal = AbortSignal.any([ctx.signal, stop.signal]);

  try {
    const outcomes = await Promise.allSettled(
      ids.map((id) =>
        singleIdPacer.run(
          async () => {
            // A slot can open as the deadline lands, before its clock fires.
            if (Date.now() >= budget.deadlineAt) throw unsent;
            try {
              const body = await fetchFdc<unknown>('/foods', {
                method: 'POST',
                body: { fdcIds: [id] },
                ctx,
                request: 'record',
                budget,
                signal: refetchSignal,
              });
              return batchFoodList(body);
            } catch (error) {
              /**
               * The first failure FDC would repeat stops the split. A caller
               * abort fails refetches the same way, but `ctx.signal` is read
               * first below, so the caller's reason always wins.
               */
              if (!stop.signal.aborted && !isTransientFailure(error)) {
                fatal = error;
                stop.abort();
              }
              throw error;
            }
          },
          { signal: queueSignal },
        ),
      ),
    );
    ctx.signal.throwIfAborted();
    if (stop.signal.aborted) throw fatal;

    const rejections = outcomes.flatMap((o) => (o.status === 'rejected' ? [o.reason] : []));
    const deferredIds = ids.filter((_id, i) => outcomes[i]?.status === 'rejected');
    if (deferredIds.length === ids.length) {
      const failure = rejections.find((reason) => reason !== unsent && !isDeadlineExpiry(reason));
      if (failure !== undefined) throw failure;
      const s = budget.attempts === 1 ? '' : 's';
      throw reportDeadline(
        budget,
        timeout(
          `FDC /foods request exceeded its ${DEADLINE_MS}ms retry deadline after ${budget.attempts} attempt${s}.`,
          {
            reason: 'retry_deadline_exceeded',
            deadlineMs: DEADLINE_MS,
            elapsedMs: Date.now() - (budget.deadlineAt - DEADLINE_MS),
            retryAttempts: budget.attempts,
          },
          { cause: rejections[0] },
        ),
      );
    }
    if (deferredIds.length > 0) {
      ctx.log.notice('FDC did not return every ID before the call deadline or kept failing', {
        requested: ids.length,
        deferred: deferredIds.length,
      });
    }
    return {
      records: outcomes.flatMap((o) => (o.status === 'fulfilled' ? o.value : [])),
      deferredIds,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The records FDC returned for `fdcIds` under one {@link DEADLINE_MS} budget,
 * and the distinct IDs a split left unanswered ({@link fetchEachId}). One
 * `{ fdcIds }` request — the full format, because `format: "abridged"` keys
 * nutrients by SR number with no nutrient id and omits portions — or, once
 * that request's attempt runs out of time, one request per distinct ID.
 */
async function fetchBatch(
  fdcIds: number[],
  ctx: Context,
): Promise<{ records: RawFoodDetail[]; deferredIds: number[] }> {
  const budget = startBudget();
  const distinct = [...new Set(fdcIds)];
  try {
    const body = await fetchFdc<unknown>('/foods', {
      method: 'POST',
      body: { fdcIds },
      ctx,
      request: distinct.length === 1 ? 'record' : 'batch',
      budget,
    });
    return { records: batchFoodList(body), deferredIds: [] };
  } catch (error) {
    if (!isAttemptTimeout(error)) throw reportDeadline(budget, error);
    ctx.log.info('FDC batch attempt timed out; refetching each ID', { count: distinct.length });
    return await fetchEachId(distinct, budget, ctx);
  }
}

// ---- Service class ----

export class FdcService {
  /**
   * Search foods by keyword. `brandOwner` and `foodCategory` are trimmed and
   * sent through {@link encodeFdcFilter}; blank ones stay off the wire.
   * `requireAllWords: true` sends FDC's native flag of the same name, so only
   * foods matching every query word count; otherwise the field is not sent.
   */
  async searchFoods(
    params: {
      query: string;
      dataType?: FdcDataType[];
      brandOwner?: string;
      foodCategory?: string;
      pageSize?: number;
      pageNumber?: number;
      requireAllWords?: boolean;
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
    const brandOwner = params.brandOwner?.trim();
    if (brandOwner) body.brandOwner = encodeFdcFilter(brandOwner);
    const foodCategory = params.foodCategory?.trim();
    if (foodCategory) body.foodCategory = encodeFdcFilter(foodCategory);
    if (params.requireAllWords) body.requireAllWords = true;

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
   * Fetch full nutrient detail for a single food by FDC ID. `provenance: true`
   * attaches FDC's per-nutrient derivation, sample count, and spread to each
   * nutrient ({@link nutrientProvenance}); by default none is attached.
   */
  async getFoodDetail(
    fdcId: number,
    nutrientFilter: number[] | undefined,
    ctx: Context,
    options: { provenance?: boolean } = {},
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
      request: 'record',
    });

    return normalizeFoodDetail(raw, nutrientFilter, options.provenance);
  }

  /**
   * Batch fetch nutrient profiles for multiple foods (up to 20 IDs) through
   * {@link fetchBatch}. Returns per-food results in request order, the IDs FDC
   * returned no data for, and the distinct IDs it did not return before the
   * call's deadline or kept failing on — those appear in neither `foods` nor
   * `failed`. `provenance` works as on {@link getFoodDetail}.
   */
  async getFoodsBatch(
    fdcIds: number[],
    nutrientFilter: number[] | undefined,
    ctx: Context,
    options: { provenance?: boolean } = {},
  ): Promise<{
    foods: FoodDetail[];
    failed: Array<{ fdcId: number; error: string }>;
    deferredIds: number[];
  }> {
    ctx.log.debug('Fetching FDC batch foods', { count: fdcIds.length });

    const { records, deferredIds } = await fetchBatch(fdcIds, ctx);
    const returnedMap = new Map<number, RawFoodDetail>();
    for (const item of records) {
      if (item.fdcId) returnedMap.set(item.fdcId, item);
    }
    const deferred = new Set(deferredIds);

    const foods: FoodDetail[] = [];
    const failed: Array<{ fdcId: number; error: string }> = [];

    for (const id of fdcIds) {
      if (deferred.has(id)) continue;
      const raw = returnedMap.get(id);
      if (!raw) {
        failed.push({ fdcId: id, error: `FDC ID ${id} not found or returned no data.` });
      } else {
        foods.push(normalizeFoodDetail(raw, nutrientFilter, options.provenance));
      }
    }

    return { foods, failed, deferredIds };
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
