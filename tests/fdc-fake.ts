/**
 * @fileoverview Stand-in for the USDA FoodData Central API over the framework's
 * fetch harness, for tests that exercise the real `FdcService` instead of
 * mocking it. It reproduces the one upstream rule local normalization has to
 * agree with: the `nutrients` filter matches SR **numbers** (`"208"`), never FDC
 * nutrient **ids** (`1008`), and an unmatched filter yields an empty
 * `foodNutrients[]` rather than an error.
 *
 * Fixture values are real FDC responses for Kale and Spinach, trimmed to the
 * fields the service reads. Both carry Total Sugars (2000) and neither carries
 * Sugars, Total (1063) — matching FDC, where 1063 is effectively Foundation-only.
 * That gives tests a nutrient that is genuinely absent rather than filtered out,
 * without pretending these foods have no sugars data at all.
 * @module tests/fdc-fake
 */

import { createFetchMock, type FetchMockHarness } from '@cyanheads/mcp-ts-core/testing';
import type { RawFoodDetail } from '@/services/fdc/types.js';

const BASE_PATH = '/fdc/v1';

/** Kale, raw (SR Legacy) — a subset of the 112 nutrients FDC returns. */
export const RAW_KALE: RawFoodDetail = {
  fdcId: 168421,
  description: 'Kale, raw',
  dataType: 'SR Legacy',
  publicationDate: '4/1/2019',
  foodCategory: { description: 'Vegetables and Vegetable Products' },
  foodPortions: [{ gramWeight: 21, modifier: 'cup', measureUnit: { name: 'undetermined' } }],
  foodNutrients: [
    { nutrient: { id: 1008, number: '208', name: 'Energy', unitName: 'kcal' }, amount: 35 },
    { nutrient: { id: 1003, number: '203', name: 'Protein', unitName: 'g' }, amount: 2.92 },
    {
      nutrient: { id: 1004, number: '204', name: 'Total lipid (fat)', unitName: 'g' },
      amount: 1.49,
    },
    {
      nutrient: { id: 1005, number: '205', name: 'Carbohydrate, by difference', unitName: 'g' },
      amount: 4.42,
    },
    {
      nutrient: { id: 1079, number: '291', name: 'Fiber, total dietary', unitName: 'g' },
      amount: 4.1,
    },
    {
      nutrient: { id: 1258, number: '606', name: 'Fatty acids, total saturated', unitName: 'g' },
      amount: 0.178,
    },
    { nutrient: { id: 1093, number: '307', name: 'Sodium, Na', unitName: 'mg' }, amount: 53 },
    { nutrient: { id: 1092, number: '306', name: 'Potassium, K', unitName: 'mg' }, amount: 348 },
    { nutrient: { id: 1087, number: '301', name: 'Calcium, Ca', unitName: 'mg' }, amount: 254 },
    { nutrient: { id: 1089, number: '303', name: 'Iron, Fe', unitName: 'mg' }, amount: 1.6 },
    { nutrient: { id: 2000, number: '269', name: 'Total Sugars', unitName: 'g' }, amount: 0.99 },
    {
      nutrient: {
        id: 1162,
        number: '401',
        name: 'Vitamin C, total ascorbic acid',
        unitName: 'mg',
      },
      amount: 93.4,
    },
  ],
};

const kaleNutrients = RAW_KALE.foodNutrients;
if (!kaleNutrients) throw new Error('RAW_KALE fixture must declare foodNutrients');

/** How many nutrients each fixture food carries — the unfiltered result size. */
export const FIXTURE_NUTRIENT_COUNT = kaleNutrients.length;

/** Spinach, raw (SR Legacy) — same nutrient set as {@link RAW_KALE}. */
export const RAW_SPINACH: RawFoodDetail = {
  fdcId: 168462,
  description: 'Spinach, raw',
  dataType: 'SR Legacy',
  publicationDate: '4/1/2019',
  foodCategory: { description: 'Vegetables and Vegetable Products' },
  foodPortions: [
    { gramWeight: 340, modifier: 'bunch', measureUnit: { name: 'undetermined' } },
    { gramWeight: 10, modifier: 'leaf', measureUnit: { name: 'undetermined' } },
  ],
  foodNutrients: [
    { nutrient: { id: 1008, number: '208', name: 'Energy', unitName: 'kcal' }, amount: 23 },
    { nutrient: { id: 1003, number: '203', name: 'Protein', unitName: 'g' }, amount: 2.86 },
    {
      nutrient: { id: 1004, number: '204', name: 'Total lipid (fat)', unitName: 'g' },
      amount: 0.39,
    },
    {
      nutrient: { id: 1005, number: '205', name: 'Carbohydrate, by difference', unitName: 'g' },
      amount: 3.63,
    },
    {
      nutrient: { id: 1079, number: '291', name: 'Fiber, total dietary', unitName: 'g' },
      amount: 2.2,
    },
    {
      nutrient: { id: 1258, number: '606', name: 'Fatty acids, total saturated', unitName: 'g' },
      amount: 0.063,
    },
    { nutrient: { id: 1093, number: '307', name: 'Sodium, Na', unitName: 'mg' }, amount: 79 },
    { nutrient: { id: 1092, number: '306', name: 'Potassium, K', unitName: 'mg' }, amount: 558 },
    { nutrient: { id: 1087, number: '301', name: 'Calcium, Ca', unitName: 'mg' }, amount: 99 },
    { nutrient: { id: 1089, number: '303', name: 'Iron, Fe', unitName: 'mg' }, amount: 2.71 },
    { nutrient: { id: 2000, number: '269', name: 'Total Sugars', unitName: 'g' }, amount: 0.42 },
    {
      nutrient: {
        id: 1162,
        number: '401',
        name: 'Vitamin C, total ascorbic acid',
        unitName: 'mg',
      },
      amount: 28.1,
    },
  ],
};

const CATALOG = new Map<number, RawFoodDetail>([
  [RAW_KALE.fdcId, RAW_KALE],
  [RAW_SPINACH.fdcId, RAW_SPINACH],
]);

/**
 * FDC's own `nutrients` filter — it compares against `nutrient.number`, so a
 * caller sending nutrient ids matches nothing and gets an empty list back.
 */
function applyUpstreamFilter(food: RawFoodDetail, filter: readonly string[]): RawFoodDetail {
  if (filter.length === 0) return food;
  return {
    ...food,
    foodNutrients: (food.foodNutrients ?? []).filter((n) =>
      filter.includes(n.nutrient?.number ?? ''),
    ),
  };
}

function lookup(fdcId: number): RawFoodDetail {
  const food = CATALOG.get(fdcId);
  if (!food) throw new Error(`fdc-fake has no fixture for FDC ID ${fdcId}`);
  return food;
}

/** Ids the batch endpoint knows about — FDC omits the rest from its response. */
export function isKnownFdcId(fdcId: number): boolean {
  return CATALOG.has(fdcId);
}

/**
 * Builds an installed-on-demand fetch harness serving `/food/{fdcId}` and the
 * `/foods` batch endpoint. Call `install()` before exercising the service and
 * `restore()` afterwards; unmatched requests throw.
 */
export function createFdcFake(): FetchMockHarness {
  return createFetchMock([
    {
      method: 'GET',
      match: (request) => new URL(request.url).pathname.startsWith(`${BASE_PATH}/food/`),
      respond: (request) => {
        const url = new URL(request.url);
        const fdcId = Number(url.pathname.slice(`${BASE_PATH}/food/`.length));
        return Response.json(
          applyUpstreamFilter(lookup(fdcId), url.searchParams.getAll('nutrients')),
        );
      },
    },
    {
      method: 'POST',
      match: (request) => new URL(request.url).pathname === `${BASE_PATH}/foods`,
      respond: async (request) => {
        const body = (await request.json()) as { fdcIds: number[]; nutrients?: number[] };
        const filter = (body.nutrients ?? []).map(String);
        // FDC drops unknown ids from the batch response rather than erroring.
        const found = body.fdcIds.filter(isKnownFdcId);
        return Response.json(found.map((id) => applyUpstreamFilter(lookup(id), filter)));
      },
    },
  ]);
}
