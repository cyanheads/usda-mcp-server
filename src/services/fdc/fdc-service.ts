/**
 * @fileoverview USDA FoodData Central API service — search, single-food fetch, and batch fetch.
 * @module services/fdc/fdc-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
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

// ---- Request helper ----

function fetchFdc<T>(
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

  return withRetry(
    async () => {
      const fetchOptions: RequestInit = {
        method: options.method ?? 'GET',
        signal: options.ctx.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': apiKey,
        },
      };
      if (options.body != null) {
        fetchOptions.body = JSON.stringify(options.body);
      }

      const response = await fetchWithTimeout(url.toString(), TIMEOUT_MS, options.ctx, {
        ...fetchOptions,
        signal: options.ctx.signal,
        ...(options.expectedStatuses && { expectedStatuses: options.expectedStatuses }),
      });

      if (!response.ok) {
        throw await httpErrorFromResponse(response, {
          service: 'USDA FDC',
          data: { path },
        });
      }

      const text = await response.text();
      if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
        throw serviceUnavailable(
          'USDA FDC API returned HTML instead of JSON — likely rate-limited.',
        );
      }

      return JSON.parse(text) as T;
    },
    {
      operation: `FdcService${path}`,
      context: options.ctx,
      baseDelayMs: 1000,
      signal: options.ctx.signal,
    },
  );
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
    ctx.log.debug('Searching FDC foods', { query: params.query, dataType: params.dataType });

    const body: Record<string, unknown> = {
      query: params.query,
      pageSize: params.pageSize ?? 10,
      pageNumber: params.pageNumber ?? 1,
    };
    if (params.dataType?.length) body.dataType = params.dataType;
    if (params.brandOwner?.trim()) body.brandOwner = params.brandOwner.trim();
    if (params.foodCategory?.trim()) body.foodCategory = params.foodCategory.trim();

    const raw = await fetchFdc<RawSearchResponse>('/foods/search', {
      method: 'POST',
      body,
      ctx,
    });

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

    // The API returns a 200 with the object even for missing IDs in some edge cases,
    // but fdcId would be 0 or description missing. The 404 path goes through httpErrorFromResponse.
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
