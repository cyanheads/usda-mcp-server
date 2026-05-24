/**
 * @fileoverview USDA FoodData Central API service — search, single-food fetch, and batch fetch.
 * @module services/fdc/fdc-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  fetchWithTimeout,
  httpErrorFromResponse,
  type RequestContext,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
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
  const result: FoodNutrient = { id, name, number, amount, unit };
  if (raw.percentDailyValue != null) {
    result.percentDailyValue = raw.percentDailyValue;
  }
  return result;
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

  const result: SearchResultFood = {
    fdcId: raw.fdcId,
    description: raw.description,
    dataType: raw.dataType ?? 'Unknown',
    nutrients,
  };
  if (raw.foodCategory) result.foodCategory = raw.foodCategory;
  if (raw.brandOwner) result.brandOwner = raw.brandOwner;
  if (raw.brandName) result.brandName = raw.brandName;
  if (raw.servingSize != null) result.servingSize = raw.servingSize;
  if (raw.servingSizeUnit) result.servingSizeUnit = raw.servingSizeUnit;
  if (raw.householdServingFullText) result.householdServingFullText = raw.householdServingFullText;
  if (raw.publishedDate) result.publishedDate = raw.publishedDate;
  return result;
}

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

  const result: FoodDetail = {
    fdcId: raw.fdcId,
    description: raw.description,
    dataType: raw.dataType ?? 'Unknown',
    nutrients,
    portions,
  };
  const category = normalizeFoodCategory(raw.foodCategory);
  if (category) result.foodCategory = category;
  if (raw.publicationDate) result.publicationDate = raw.publicationDate;
  if (raw.brandOwner) result.brandOwner = raw.brandOwner;
  if (raw.brandName) result.brandName = raw.brandName;
  if (raw.ingredients) result.ingredients = raw.ingredients;
  return result;
}

// ---- Request helper ----

function fetchFdc<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST';
    params?: Record<string, string | string[] | number | number[] | undefined>;
    body?: unknown;
    ctx: Context;
  },
): Promise<T> {
  const apiKey = getServerConfig().fdcApiKey;
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('api_key', apiKey);

  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, String(v));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return withRetry(
    async () => {
      const fetchOptions: RequestInit = {
        method: options.method ?? 'GET',
        signal: options.ctx.signal,
        headers: { 'Content-Type': 'application/json' },
      };
      if (options.body != null) {
        fetchOptions.body = JSON.stringify(options.body);
      }

      // Context is safe to pass as RequestContext per framework docs —
      // fetchWithTimeout/withRetry strip non-serializable fields before logging.
      const reqCtx = options.ctx as unknown as RequestContext;
      const response = await fetchWithTimeout(url.toString(), TIMEOUT_MS, reqCtx, {
        ...fetchOptions,
        signal: options.ctx.signal,
      });

      if (!response.ok) {
        throw await httpErrorFromResponse(response, {
          service: 'USDA FDC',
          data: { path },
        });
      }

      const text = await response.text();
      if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
        const { serviceUnavailable } = await import('@cyanheads/mcp-ts-core/errors');
        throw serviceUnavailable(
          'USDA FDC API returned HTML instead of JSON — likely rate-limited.',
        );
      }

      return JSON.parse(text) as T;
    },
    {
      operation: `FdcService${path}`,
      context: options.ctx as unknown as RequestContext,
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

    const params: Record<string, string | number[]> = {};
    if (nutrientFilter?.length) params.nutrients = nutrientFilter;

    const raw = await fetchFdc<RawFoodDetail>(`/food/${fdcId}`, { params, ctx });

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

    const body: Record<string, unknown> = { fdcIds };
    if (nutrientFilter?.length) body.nutrients = nutrientFilter;
    // Do NOT use format: "abridged" — abridged returns empty foodNutrients[]

    const rawList = await fetchFdc<RawFoodDetail[]>('/foods', {
      method: 'POST',
      body,
      ctx,
    });

    // Map returned foods by fdcId for lookup
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

export function initFdcService(_config: AppConfig, _storage: StorageService): void {
  _service = new FdcService();
}

export function getFdcService(): FdcService {
  if (!_service) {
    throw new Error('FdcService not initialized — call initFdcService() in setup()');
  }
  return _service;
}
