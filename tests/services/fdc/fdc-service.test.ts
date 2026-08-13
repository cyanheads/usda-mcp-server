/**
 * @fileoverview Tests for FdcService against a stand-in FoodData Central API.
 * The tool and resource suites mock this service wholesale, so its real
 * normalization and nutrient-filter path is only exercised here.
 * @module tests/services/fdc/fdc-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FdcService } from '@/services/fdc/fdc-service.js';
import { createFdcFake, FIXTURE_NUTRIENT_COUNT } from '../../fdc-fake.js';

const KALE = 168421;
const SPINACH = 168462;
const ENERGY = 1008;
const PROTEIN = 1003;
const IRON = 1089;
/** Sugars, Total — genuinely absent from both fixture foods, as it is in FDC. */
const SUGARS = 1063;

let http: ReturnType<typeof createFdcFake>;
let service: FdcService;

/** Query parameters the service put on the wire for call `index`. */
function requestParams(index: number): URLSearchParams {
  const call = http.calls[index];
  if (!call) throw new Error(`No upstream call at index ${index}`);
  return new URL(call.request.url).searchParams;
}

/** JSON body the service put on the wire for call `index`. */
async function requestBody(index: number): Promise<Record<string, unknown>> {
  const call = http.calls[index];
  if (!call) throw new Error(`No upstream call at index ${index}`);
  return (await call.request.json()) as Record<string, unknown>;
}

describe('FdcService', () => {
  beforeEach(() => {
    vi.stubEnv('USDA_FDC_API_KEY', 'test-key');
    http = createFdcFake();
    http.install();
    service = new FdcService();
  });

  afterEach(() => {
    http.restore();
    vi.unstubAllEnvs();
  });

  describe('getFoodDetail', () => {
    it('returns only the requested nutrient ids', async () => {
      const ctx = createMockContext();
      const food = await service.getFoodDetail(KALE, [ENERGY, PROTEIN], ctx);

      expect(food.nutrients.map((n) => n.id)).toEqual([ENERGY, PROTEIN]);
      expect(food.nutrients).toEqual([
        { id: ENERGY, name: 'Energy', number: '208', amount: 35, unit: 'kcal' },
        { id: PROTEIN, name: 'Protein', number: '203', amount: 2.92, unit: 'g' },
      ]);
    });

    it('never sends nutrient ids to the upstream nutrients filter', async () => {
      const ctx = createMockContext();
      await service.getFoodDetail(KALE, [ENERGY, PROTEIN], ctx);

      // FDC's `nutrients` parameter matches SR numbers ("208"), so any id-space
      // value sent here comes back as an empty foodNutrients[].
      expect(requestParams(0).getAll('nutrients')).toEqual([]);
    });

    it('returns every nutrient when no filter is given', async () => {
      const ctx = createMockContext();
      const food = await service.getFoodDetail(KALE, undefined, ctx);

      expect(food.nutrients).toHaveLength(FIXTURE_NUTRIENT_COUNT);
      expect(food.nutrients.map((n) => n.id)).toContain(IRON);
    });

    it('treats an empty filter as no filter', async () => {
      const ctx = createMockContext();
      const food = await service.getFoodDetail(KALE, [], ctx);

      expect(food.nutrients).toHaveLength(FIXTURE_NUTRIENT_COUNT);
    });

    it('omits a nutrient the food genuinely lacks while keeping the rest', async () => {
      const ctx = createMockContext();
      const food = await service.getFoodDetail(KALE, [PROTEIN, SUGARS], ctx);

      expect(food.nutrients.map((n) => n.id)).toEqual([PROTEIN]);
    });

    it('returns an empty nutrient list when no requested id is present', async () => {
      const ctx = createMockContext();
      const food = await service.getFoodDetail(KALE, [SUGARS], ctx);

      expect(food.nutrients).toEqual([]);
      expect(food.description).toBe('Kale, raw');
    });

    it('normalizes nested category, portion, and nutrient sub-objects', async () => {
      const ctx = createMockContext();
      const food = await service.getFoodDetail(SPINACH, undefined, ctx);

      expect(food.foodCategory).toBe('Vegetables and Vegetable Products');
      expect(food.portions).toEqual([
        { description: 'bunch undetermined', gramWeight: 340 },
        { description: 'leaf undetermined', gramWeight: 10 },
      ]);
      const iron = food.nutrients.find((n) => n.id === IRON);
      expect(iron).toEqual({
        id: IRON,
        name: 'Iron, Fe',
        number: '303',
        amount: 2.71,
        unit: 'mg',
      });
    });
  });

  describe('getFoodsBatch', () => {
    it('returns the requested nutrient ids for every food', async () => {
      const ctx = createMockContext();
      const { foods, failed } = await service.getFoodsBatch(
        [KALE, SPINACH],
        [ENERGY, PROTEIN],
        ctx,
      );

      expect(failed).toEqual([]);
      expect(foods.map((f) => f.fdcId)).toEqual([KALE, SPINACH]);
      for (const food of foods) {
        expect(food.nutrients.map((n) => n.id)).toEqual([ENERGY, PROTEIN]);
      }
      expect(foods[0]?.nutrients[0]?.amount).toBe(35);
      expect(foods[1]?.nutrients[0]?.amount).toBe(23);
    });

    it('never sends nutrient ids to the upstream nutrients filter', async () => {
      const ctx = createMockContext();
      await service.getFoodsBatch([KALE, SPINACH], [ENERGY, PROTEIN], ctx);

      await expect(requestBody(0)).resolves.toEqual({ fdcIds: [KALE, SPINACH] });
    });

    it('reports ids the batch endpoint did not return', async () => {
      const ctx = createMockContext();
      const { foods, failed } = await service.getFoodsBatch([KALE, 999_999], [PROTEIN], ctx);

      expect(foods.map((f) => f.fdcId)).toEqual([KALE]);
      expect(failed).toEqual([
        { fdcId: 999_999, error: 'FDC ID 999999 not found or returned no data.' },
      ]);
    });

    it('omits a nutrient the foods genuinely lack', async () => {
      const ctx = createMockContext();
      const { foods } = await service.getFoodsBatch([KALE, SPINACH], [PROTEIN, SUGARS], ctx);

      for (const food of foods) {
        expect(food.nutrients.map((n) => n.id)).toEqual([PROTEIN]);
      }
    });
  });
});
