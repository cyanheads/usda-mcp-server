/**
 * @fileoverview usda_compare_foods driven through the real FdcService against a
 * stand-in FoodData Central API. The sibling suite mocks the service and feeds
 * it pre-filtered fixtures, so it cannot see whether the nutrient filter the
 * tool sends actually resolves upstream — this one can.
 * @module tests/tools/usda-compare-foods.integration.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usdaCompareFoods } from '@/mcp-server/tools/definitions/usda-compare-foods.tool.js';
import { initFdcService } from '@/services/fdc/fdc-service.js';
import { createFdcFake } from '../fdc-fake.js';
import { firstText } from '../helpers.js';

const { format } = usdaCompareFoods;
if (!format) throw new Error('usda_compare_foods must declare format()');

const KALE = 168421;
const SPINACH = 168462;
const PROTEIN = 1003;
const IRON = 1089;
/** Total Sugars — the sugars id in the tool's 12 defaults, present in both foods. */
const TOTAL_SUGARS = 2000;
/** Sugars, Total — a real but Foundation-only id, absent from both foods in FDC. */
const FOUNDATION_SUGARS = 1063;

let http: ReturnType<typeof createFdcFake>;

describe('usdaCompareFoods over the real FdcService', () => {
  beforeEach(() => {
    vi.stubEnv('USDA_FDC_API_KEY', 'test-key');
    http = createFdcFake();
    http.install();
    initFdcService();
  });

  afterEach(() => {
    http.restore();
    vi.unstubAllEnvs();
  });

  it('populates the default 12-nutrient comparison', async () => {
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const input = usdaCompareFoods.input.parse({ fdcIds: [KALE, SPINACH] });
    const result = await usdaCompareFoods.handler(input, ctx);

    // All 12 defaults resolve against both foods.
    expect(result.nutrients).toHaveLength(12);
    expect(result.nutrients.every((row) => row.values.every((v) => v !== null))).toBe(true);

    const iron = result.nutrients.find((row) => row.id === IRON);
    expect(iron).toEqual({ id: IRON, name: 'Iron, Fe', unit: 'mg', values: [1.6, 2.71] });

    const sugars = result.nutrients.find((row) => row.id === TOTAL_SUGARS);
    expect(sugars).toEqual({
      id: TOTAL_SUGARS,
      name: 'Total Sugars',
      unit: 'g',
      values: [0.99, 0.42],
    });
  });

  it('reports nothing missing when every default resolves', async () => {
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const input = usdaCompareFoods.input.parse({ fdcIds: [KALE, SPINACH] });
    const result = await usdaCompareFoods.handler(input, ctx);

    expect(result.missingData).toBeUndefined();
  });

  it('reports a genuinely absent nutrient as missing rather than filtered out', async () => {
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const input = usdaCompareFoods.input.parse({
      fdcIds: [KALE, SPINACH],
      nutrients: [PROTEIN, FOUNDATION_SUGARS],
    });
    const result = await usdaCompareFoods.handler(input, ctx);

    expect(result.nutrients.map((row) => row.id)).toEqual([PROTEIN]);
    expect(result.missingData).toEqual([
      { fdcId: KALE, nutrientId: FOUNDATION_SUGARS },
      { fdcId: SPINACH, nutrientId: FOUNDATION_SUGARS },
    ]);
  });

  it('renders the pivot table with values in the content text', async () => {
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const input = usdaCompareFoods.input.parse({ fdcIds: [KALE, SPINACH] });
    const text = firstText(format(await usdaCompareFoods.handler(input, ctx)));

    expect(text).toContain('| Iron, Fe (mg) [ID:1089] | 1.6 | 2.71 |');
    expect(text).toContain('| Protein (g) [ID:1003] | 2.92 | 2.86 |');
    // A table whose every cell is an em dash is the empty-comparison symptom.
    expect(text).not.toContain('| — | — |');
  });

  it('honors an explicit nutrient filter on both consumption paths', async () => {
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const input = usdaCompareFoods.input.parse({
      fdcIds: [KALE, SPINACH],
      nutrients: [PROTEIN, IRON],
    });
    const result = await usdaCompareFoods.handler(input, ctx);

    expect(result.nutrients.map((row) => row.id)).toEqual([PROTEIN, IRON]);
    expect(result.missingData).toBeUndefined();
    expect(firstText(format(result))).toContain('| Iron, Fe (mg) [ID:1089] | 1.6 | 2.71 |');
  });

  it('scales every value to a non-default gram basis', async () => {
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const input = usdaCompareFoods.input.parse({
      fdcIds: [KALE, SPINACH],
      nutrients: [IRON],
      quantity: 50,
      unit: 'g',
    });
    const result = await usdaCompareFoods.handler(input, ctx);

    expect(result.nutrients[0]?.values).toEqual([0.8, 1.355]);
  });
});
