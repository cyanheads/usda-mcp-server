/**
 * @fileoverview Tests for FdcService against a stand-in FoodData Central API.
 * The tool and resource suites mock this service wholesale, so its real
 * normalization and nutrient-filter path is only exercised here.
 * @module tests/services/fdc/fdc-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
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

  /**
   * A 404 from the single-food endpoint is the declared `not_found` outcome for
   * a caller-supplied id, so it must not inflate the error rate. The opt-out is
   * scoped to that one request — `/foods` and `/foods/search` answer 200 for a
   * bad id, so a 404 from either is a genuine anomaly and stays at `error`.
   */
  describe('expected-404 log level', () => {
    /**
     * `fetchWithTimeout` logs to the framework's module-level logger, not to
     * `ctx.log`, so the severity it chose is only observable by spying there.
     */
    function spyOnFetchLogging() {
      return {
        error: vi.spyOn(logger, 'error').mockImplementation(() => {}),
        debug: vi.spyOn(logger, 'debug').mockImplementation(() => {}),
      };
    }

    /**
     * Log calls whose payload carries the HTTP status the fetch layer saw. The
     * fetch layer attaches it through `withExtra`, so it lands under the
     * context's `extra` bag — flattened again only when the line is emitted.
     */
    function statusCalls(spy: { mock: { calls: unknown[][] } }, status: number): unknown[][] {
      return spy.mock.calls.filter(
        (call) =>
          (call[1] as { extra?: { statusCode?: number } } | undefined)?.extra?.statusCode ===
          status,
      );
    }

    afterEach(() => vi.restoreAllMocks());

    it('logs a missing-food 404 at debug, not error', async () => {
      const log = spyOnFetchLogging();

      await expect(
        service.getFoodDetail(999_999, undefined, createMockContext()),
      ).rejects.toThrow();

      expect(statusCalls(log.debug, 404)).toHaveLength(1);
      expect(statusCalls(log.error, 404)).toHaveLength(0);
    });

    it('still throws the status-mapped error for a missing food', async () => {
      await expect(
        service.getFoodDetail(999_999, undefined, createMockContext()),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
    });

    it('keeps a 404 on the batch path at error', async () => {
      const batch404 = createFetchMock([
        {
          method: 'POST',
          match: (request) => new URL(request.url).pathname.endsWith('/foods'),
          respond: () => Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 }),
        },
      ]);
      batch404.install();
      try {
        const log = spyOnFetchLogging();

        await expect(
          service.getFoodsBatch([KALE], [PROTEIN], createMockContext()),
        ).rejects.toThrow();

        expect(statusCalls(log.error, 404)).toHaveLength(1);
        expect(statusCalls(log.debug, 404)).toHaveLength(0);
      } finally {
        batch404.restore();
      }
    });
  });
});
