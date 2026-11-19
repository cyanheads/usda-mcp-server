/**
 * @fileoverview Tests for usda_compare_foods tool.
 * @module tests/tools/usda-compare-foods.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, timeout } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usdaCompareFoods } from '@/mcp-server/tools/definitions/usda-compare-foods.tool.js';
import { allText, firstText, ids } from '../helpers.js';

const { format } = usdaCompareFoods;
if (!format) throw new Error('usda_compare_foods must declare format()');

/** The `usda.compare.deferrals` counter the tool creates at module scope, and the arguments of each creation. */
const deferrals = vi.hoisted(() => ({ add: vi.fn(), created: [] as unknown[][] }));

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  // Creation is recorded outside the mock's call history, which a mock reset erases.
  createCounter: vi.fn((...args: unknown[]) => {
    deferrals.created.push(args);
    return deferrals;
  }),
}));

vi.mock('@/services/fdc/fdc-service.js', () => {
  const mockService = {
    getFoodsBatch: vi.fn(),
  };
  return {
    FdcService: vi.fn(() => mockService),
    getFdcService: vi.fn(() => mockService),
    initFdcService: vi.fn(),
  };
});

async function getServiceMock() {
  const { getFdcService } = await import('@/services/fdc/fdc-service.js');
  return getFdcService() as unknown as { getFoodsBatch: ReturnType<typeof vi.fn> };
}

const SPINACH = {
  fdcId: 168462,
  description: 'Spinach, raw',
  dataType: 'SR Legacy',
  nutrients: [
    { id: 1008, name: 'Energy', number: '208', amount: 23, unit: 'KCAL' },
    { id: 1003, name: 'Protein', number: '203', amount: 2.86, unit: 'G' },
    { id: 1089, name: 'Iron, Fe', number: '303', amount: 2.71, unit: 'MG' },
  ],
  portions: [],
};

const KALE = {
  fdcId: 168421,
  description: 'Kale, raw',
  dataType: 'SR Legacy',
  nutrients: [
    { id: 1008, name: 'Energy', number: '208', amount: 35, unit: 'KCAL' },
    { id: 1003, name: 'Protein', number: '203', amount: 2.92, unit: 'G' },
    { id: 1089, name: 'Iron, Fe', number: '303', amount: 1.47, unit: 'MG' },
  ],
  portions: [],
};

/** FDC nutrient 2000 "Total Sugars" — the id SR Legacy foods actually report. */
const sugars = (amount: number) => ({
  id: 2000,
  name: 'Total Sugars',
  number: '269',
  amount,
  unit: 'G',
});

describe('usdaCompareFoods', () => {
  beforeEach(async () => {
    const service = await getServiceMock();
    service.getFoodsBatch.mockResolvedValue({
      foods: [SPINACH, KALE],
      failed: [],
      deferredIds: [],
    });
  });

  it('schema rejects fdcIds containing 0 or negative values', () => {
    expect(() => usdaCompareFoods.input.parse({ fdcIds: [0, 168421] })).toThrow();
    expect(() => usdaCompareFoods.input.parse({ fdcIds: [-1, 168421] })).toThrow();
  });

  it('schema rejects non-positive nutrient IDs', () => {
    expect(() => usdaCompareFoods.input.parse({ fdcIds: [1, 2], nutrients: [-1] })).toThrow();
    expect(() => usdaCompareFoods.input.parse({ fdcIds: [1, 2], nutrients: [0] })).toThrow();
  });

  it('schema accepts positive nutrient IDs and an omitted filter', () => {
    expect(
      usdaCompareFoods.input.parse({ fdcIds: [1, 2], nutrients: [1008, 1003] }).nutrients,
    ).toEqual([1008, 1003]);
    expect(usdaCompareFoods.input.parse({ fdcIds: [1, 2] }).nutrients).toBeUndefined();
  });

  describe('comparison size boundaries', () => {
    /**
     * The declared window is 2–500 entries. The table has one column per food
     * and compares at most 5, so distinct IDs past the fifth are deferred, not
     * rejected, and one past either edge of the window must not reach the API.
     */
    it('accepts the smallest and largest declared comparison', () => {
      expect(usdaCompareFoods.input.parse({ fdcIds: [1, 2] }).fdcIds).toHaveLength(2);
      expect(usdaCompareFoods.input.parse({ fdcIds: [1, 2, 3, 4, 5] }).fdcIds).toHaveLength(5);
      expect(usdaCompareFoods.input.parse({ fdcIds: ids(500) }).fdcIds).toHaveLength(500);
    });

    it('rejects a single id — a comparison needs something to compare against', () => {
      expect(() => usdaCompareFoods.input.parse({ fdcIds: [168421] })).toThrow();
    });

    it('accepts one past the comparison cap, deferring the rest instead of rejecting the call', () => {
      expect(usdaCompareFoods.input.parse({ fdcIds: ids(6) }).fdcIds).toHaveLength(6);
    });

    it('rejects one past the 500-entry window', async () => {
      const service = await getServiceMock();
      service.getFoodsBatch.mockClear();
      const result = await runToolContract(usdaCompareFoods, { fdcIds: ids(501) });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(firstText(result.content)).toContain('Too big: expected array to have <=500 items');
      expect(service.getFoodsBatch).not.toHaveBeenCalled();
    });

    it('advertises the 500-entry window', () => {
      expect(z.toJSONSchema(usdaCompareFoods.input).properties?.fdcIds).toMatchObject({
        minItems: 2,
        maxItems: 500,
      });
    });
  });

  it('schema rejects zero or negative quantity', () => {
    expect(() => usdaCompareFoods.input.parse({ fdcIds: [168462, 168421], quantity: 0 })).toThrow();
    expect(() =>
      usdaCompareFoods.input.parse({ fdcIds: [168462, 168421], quantity: -100 }),
    ).toThrow();
  });

  it('returns a comparison result with basis, foods, and nutrients', async () => {
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const input = usdaCompareFoods.input.parse({ fdcIds: [168462, 168421] });
    const result = await usdaCompareFoods.handler(input, ctx);

    expect(result.basis).toEqual({ quantity: 100, unit: 'g', gramWeight: 100 });
    expect(result.foods).toHaveLength(2);
    expect(result.nutrients.length).toBeGreaterThan(0);
  });

  it('uses default 100g basis when quantity is not specified', async () => {
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const input = usdaCompareFoods.input.parse({ fdcIds: [168462, 168421] });
    const result = await usdaCompareFoods.handler(input, ctx);

    const iron = result.nutrients.find((n) => n.id === 1089);
    expect(iron).toBeDefined();
    // Per 100g values should be unchanged at scale factor 1
    expect(iron?.values[0]).toBeCloseTo(2.71, 2);
    expect(iron?.values[1]).toBeCloseTo(1.47, 2);
  });

  it('scales values when a non-100g quantity is requested', async () => {
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const input = usdaCompareFoods.input.parse({
      fdcIds: [168462, 168421],
      quantity: 50,
      unit: 'g',
    });
    const result = await usdaCompareFoods.handler(input, ctx);

    const iron = result.nutrients.find((n) => n.id === 1089);
    // 50g → scaleFactor = 0.5
    expect(iron?.values[0]).toBeCloseTo(2.71 * 0.5, 2);
  });

  /**
   * quantity is an amount in unit, with the schema defaults 100 and "g". A lone
   * unit therefore compares per 100 of it, and a lone quantity is grams.
   */
  describe('basis', () => {
    const compare = async (args: { quantity?: number; unit?: 'g' | 'oz' | 'lb' | 'kg' }) => {
      const ctx = createMockContext({ errors: usdaCompareFoods.errors });
      const input = usdaCompareFoods.input.parse({ fdcIds: [168462, 168421], ...args });
      return usdaCompareFoods.handler(input, ctx);
    };

    it('compares per 100 of a lone unit', async () => {
      const result = await compare({ unit: 'oz' });

      expect(result.basis).toEqual({ quantity: 100, unit: 'oz', gramWeight: 2834.95 });
      expect(result.nutrients.find((n) => n.id === 1003)?.values).toEqual([81.0796, 82.7805]);
    });

    it('reads a lone quantity as grams', async () => {
      const result = await compare({ quantity: 30 });

      expect(result.basis).toEqual({ quantity: 30, unit: 'g', gramWeight: 30 });
    });

    it('rounds a mass conversion to the same 4 decimals as nutrient values', async () => {
      // 3 × 28.3495 is 85.04849999999999 in binary floating point
      const result = await compare({ quantity: 3, unit: 'oz' });

      expect(result.basis.gramWeight).toBe(85.0485);
    });

    it('renders the basis line with the exact gram weight basis carries', async () => {
      const basisLines = async (args: Parameters<typeof compare>[0]) =>
        firstText(format(await compare(args)))
          .split('\n')
          .filter((line) => line.startsWith('**Basis:**'));

      expect(await basisLines({ quantity: 3, unit: 'oz' })).toEqual(['**Basis:** 3 oz (85.0485g)']);
      expect(await basisLines({})).toEqual(['**Basis:** 100 g (100g)']);
    });
  });

  it('passes requested nutrient IDs to the service', async () => {
    const service = await getServiceMock();
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const input = usdaCompareFoods.input.parse({
      fdcIds: [168462, 168421],
      nutrients: [1003, 1089],
    });
    await usdaCompareFoods.handler(input, ctx);

    expect(service.getFoodsBatch).toHaveBeenCalledWith([168462, 168421], [1003, 1089], ctx);
  });

  it('throws ctx.fail("too_few_foods") when fewer than 2 foods return data', async () => {
    const service = await getServiceMock();
    service.getFoodsBatch.mockResolvedValue({
      foods: [SPINACH],
      failed: [{ fdcId: 168421, error: 'Not found.' }],
      deferredIds: [],
    });
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const input = usdaCompareFoods.input.parse({ fdcIds: [168462, 168421] });

    await expect(usdaCompareFoods.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'too_few_foods' },
    });
  });

  it('populates missingData for failed IDs', async () => {
    const service = await getServiceMock();
    service.getFoodsBatch.mockResolvedValue({
      foods: [SPINACH, KALE],
      failed: [{ fdcId: 999, error: 'Not found.' }],
      deferredIds: [],
    });
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const input = usdaCompareFoods.input.parse({ fdcIds: [168462, 168421, 999] });
    const result = await usdaCompareFoods.handler(input, ctx);

    expect(result.missingData).toBeDefined();
    const notFound = result.missingData!.filter((m) => m.nutrientId === null);
    expect(notFound.some((m) => m.fdcId === 999)).toBe(true);
  });

  it('filters out nutrient rows where all values are null', async () => {
    // Feed a food pair where one nutrient (1162) has no data at all
    const foodA = {
      ...SPINACH,
      nutrients: [{ id: 1003, name: 'Protein', number: '203', amount: 2.86, unit: 'G' }],
    };
    const foodB = {
      ...KALE,
      nutrients: [{ id: 1003, name: 'Protein', number: '203', amount: 2.92, unit: 'G' }],
    };
    const service = await getServiceMock();
    service.getFoodsBatch.mockResolvedValue({ foods: [foodA, foodB], failed: [], deferredIds: [] });

    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const input = usdaCompareFoods.input.parse({
      fdcIds: [168462, 168421],
      nutrients: [1003, 1162], // 1162 not in either food
    });
    const result = await usdaCompareFoods.handler(input, ctx);

    // 1162 has all null values → should be filtered out
    const vitC = result.nutrients.find((n) => n.id === 1162);
    expect(vitC).toBeUndefined();
    // 1003 has values → present
    const protein = result.nutrients.find((n) => n.id === 1003);
    expect(protein).toBeDefined();
  });

  it('formats output as a markdown table with food descriptions and FDC IDs', () => {
    const output = {
      basis: { quantity: 100, unit: 'g', gramWeight: 100 },
      foods: [
        { fdcId: 168462, description: 'Spinach, raw', dataType: 'SR Legacy' },
        { fdcId: 168421, description: 'Kale, raw', dataType: 'SR Legacy' },
      ],
      nutrients: [{ id: 1089, name: 'Iron, Fe', unit: 'MG', values: [2.71, 1.47] }],
    };
    const text = firstText(format(output));
    // Table structure
    expect(text).toContain('Spinach, raw');
    expect(text).toContain('Kale, raw');
    expect(text).toContain('Iron, Fe');
    expect(text).toContain('1089');
    expect(text).toContain('2.71');
    // FDC IDs appear in the food summary section
    expect(text).toContain('168462');
    expect(text).toContain('168421');
  });

  it('escapes a pipe in a food description so the table keeps one column per food', () => {
    const output = {
      basis: { quantity: 100, unit: 'g', gramWeight: 100 },
      foods: [
        { fdcId: 1, description: 'Spinach | raw', dataType: 'Branded' },
        { fdcId: 2, description: 'Kale, *baby*', dataType: 'Branded' },
      ],
      nutrients: [{ id: 1089, name: 'Iron, Fe', unit: 'MG', values: [2.71, 1.47] }],
    };
    const text = firstText(format(output));
    expect(text).toContain('| Nutrient | Spinach \\| raw (1) | Kale, \\*baby\\* (2) |');
    expect(text).toContain(
      '- **Spinach \\| raw** (FDC ID: 1, type: Branded, basis: per 100 label units (basis unverified, no label unit))',
    );
  });

  it('escapes a pipe in a nutrient unit so the row keeps one cell per food, and in a data type', () => {
    const output = {
      basis: { quantity: 100, unit: 'g', gramWeight: 100 },
      foods: [
        { fdcId: 1, description: 'Spinach, raw', dataType: 'SR|Legacy*' },
        { fdcId: 2, description: 'Kale, raw', dataType: 'SR Legacy' },
      ],
      nutrients: [
        { id: 1089, name: 'Iron, Fe', unit: 'mg|x*', values: [2.71, 1.47] },
        { id: 1158, name: 'Vitamin E', unit: 'MG_ATE', values: [2.03, null] },
      ],
    };
    const text = firstText(format(output));
    expect(text).toContain('| Iron, Fe (mg\\|x\\*) [ID:1089] | 2.71 | 1.47 |');
    // A unit FDC really sends reads as sent.
    expect(text).toContain('| Vitamin E (MG_ATE) [ID:1158] | 2.03 | — |');
    expect(text).toContain('- **Spinach, raw** (FDC ID: 1, type: SR\\|Legacy\\*, ');
    expect(text).toContain('- **Kale, raw** (FDC ID: 2, type: SR Legacy, ');
  });

  it('formats missing data section when present', () => {
    const output = {
      basis: { quantity: 100, unit: 'g', gramWeight: 100 },
      foods: [
        { fdcId: 168462, description: 'Spinach, raw', dataType: 'SR Legacy' },
        { fdcId: 168421, description: 'Kale, raw', dataType: 'SR Legacy' },
      ],
      nutrients: [],
      missingData: [
        { fdcId: 999, nutrientId: null },
        { fdcId: 168462, nutrientId: 1162 },
      ],
    };
    const text = firstText(format(output));
    expect(text).toContain('Missing data');
    expect(text).toContain('999');
    expect(text).toContain('1162');
  });

  /**
   * FDC splits total sugars across two distinct nutrients: 2000 "Total Sugars"
   * (number 269), which SR Legacy, Survey (FNDDS) and Branded foods report, and
   * 1063 "Sugars, Total" (number 269.3), which effectively only Foundation
   * foods carry. The default set must request the one the common data types
   * report, or every default comparison buries a sugars value the food has.
   */
  describe('default sugars nutrient', () => {
    const WITH_TOTAL_SUGARS = [
      { ...SPINACH, nutrients: [...SPINACH.nutrients, sugars(0.42)] },
      { ...KALE, nutrients: [...KALE.nutrients, sugars(0.99)] },
    ];

    beforeEach(async () => {
      const service = await getServiceMock();
      service.getFoodsBatch.mockResolvedValue({
        foods: WITH_TOTAL_SUGARS,
        failed: [],
        deferredIds: [],
      });
    });

    it('populates the sugars row for SR Legacy foods under the default filter', async () => {
      const ctx = createMockContext({ errors: usdaCompareFoods.errors });
      const input = usdaCompareFoods.input.parse({ fdcIds: [168462, 168421] });
      const result = await usdaCompareFoods.handler(input, ctx);

      expect(result.nutrients.find((n) => n.id === 2000)?.values).toEqual([0.42, 0.99]);
      expect(result.missingData ?? []).not.toContainEqual(
        expect.objectContaining({ nutrientId: 1063 }),
      );
    });

    it('renders the sugars row on the content[] path', async () => {
      const ctx = createMockContext({ errors: usdaCompareFoods.errors });
      const input = usdaCompareFoods.input.parse({ fdcIds: [168462, 168421] });
      const text = firstText(format(await usdaCompareFoods.handler(input, ctx)));

      expect(text).toContain('Total Sugars');
      expect(text).toContain('ID:2000');
      expect(text).toContain('0.99');
      expect(text).not.toContain('1063');
    });

    it('still reports an explicitly requested 1063 as missing when absent', async () => {
      const ctx = createMockContext({ errors: usdaCompareFoods.errors });
      const input = usdaCompareFoods.input.parse({ fdcIds: [168462, 168421], nutrients: [1063] });
      const result = await usdaCompareFoods.handler(input, ctx);

      expect(result.nutrients).toEqual([]);
      expect(result.missingData).toEqual([
        { fdcId: 168462, nutrientId: 1063 },
        { fdcId: 168421, nutrientId: 1063 },
      ]);
    });
  });
});

/** A nutrient entry as the service normalizes it. */
const nutrient = (id: number, name: string, amount: number, unit: string) => ({
  id,
  name,
  number: '',
  amount,
  unit,
});

/**
 * Foundation records report energy as the Atwater estimates 2048 (specific
 * factors) and 2047 (general factors) instead of 1008, and sugars as 1063
 * instead of 2000. A default comparison fills those rows from the equivalent
 * id, 2048 before 2047; an explicit nutrients[] stays literal.
 */
describe('usdaCompareFoods default-row fill', () => {
  const food = (fdcId: number, nutrients: ReturnType<typeof nutrient>[]) => ({
    fdcId,
    description: `Food ${fdcId}`,
    dataType: 'Foundation',
    basisUnit: 'g' as const,
    nutrients,
    portions: [],
  });

  /** One food per branch of the energy fallback chain, plus one with nothing to fill from. */
  const DIRECT = food(1, [
    nutrient(1008, 'Energy', 40, 'KCAL'),
    nutrient(2048, 'Energy (Atwater Specific Factors)', 41, 'KCAL'),
  ]);
  const BOTH_ESTIMATES = food(2, [
    nutrient(2047, 'Energy (Atwater General Factors)', 52, 'KCAL'),
    nutrient(2048, 'Energy (Atwater Specific Factors)', 50.12346, 'KCAL'),
    nutrient(1063, 'Sugars, Total', 3, 'G'),
  ]);
  const GENERAL_ONLY = food(3, [nutrient(2047, 'Energy (Atwater General Factors)', 60, 'KCAL')]);
  const NO_ENERGY = food(4, [nutrient(2000, 'Total Sugars', 2, 'G')]);
  const FOODS = [DIRECT, BOTH_ESTIMATES, GENERAL_ONLY, NO_ENERGY];

  const compare = async (args: { nutrients?: number[]; quantity?: number }, foods = FOODS) => {
    const service = await getServiceMock();
    service.getFoodsBatch.mockResolvedValue({ foods, failed: [], deferredIds: [] });
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    return usdaCompareFoods.handler(
      usdaCompareFoods.input.parse({ fdcIds: foods.map((f) => f.fdcId), ...args }),
      ctx,
    );
  };

  it('fills Energy from 2048, then 2047, and Sugars from 1063, recording each fill', async () => {
    const result = await compare({});

    expect(result.nutrients.find((r) => r.id === 1008)).toEqual({
      id: 1008,
      name: 'Energy',
      unit: 'KCAL',
      values: [40, 50.1235, 60, null],
    });
    expect(result.nutrients.find((r) => r.id === 2000)).toEqual({
      id: 2000,
      name: 'Total Sugars',
      unit: 'G',
      values: [null, 3, null, 2],
    });
    expect(result.substitutions).toEqual([
      { fdcId: 2, requested: 1008, used: 2048 },
      { fdcId: 3, requested: 1008, used: 2047 },
      { fdcId: 2, requested: 2000, used: 1063 },
    ]);
    // An unfillable cell stays missing under the requested id; a filled one never is.
    expect(result.missingData).toContainEqual({ fdcId: 4, nutrientId: 1008 });
    expect(result.missingData).toContainEqual({ fdcId: 1, nutrientId: 2000 });
    expect(result.missingData).not.toContainEqual({ fdcId: 2, nutrientId: 1008 });
    expect(result.missingData).not.toContainEqual({ fdcId: 2, nutrientId: 2000 });
    expect(result.missingData?.map((m) => m.nutrientId)).not.toContain(2048);
  });

  it('names a row from the nutrient reference when no food reports the requested id', async () => {
    const result = await compare({}, [BOTH_ESTIMATES, GENERAL_ONLY]);

    expect(result.nutrients.find((r) => r.id === 1008)).toEqual({
      id: 1008,
      name: 'Energy',
      unit: 'KCAL',
      values: [50.1235, 60],
    });
    expect(result.nutrients.find((r) => r.id === 2000)).toMatchObject({
      name: 'Total Sugars',
      unit: 'G',
    });
  });

  it('scales filled values with the comparison basis', async () => {
    const result = await compare({ quantity: 50 });

    expect(result.nutrients.find((r) => r.id === 1008)?.values).toEqual([20, 25.0617, 30, null]);
  });

  it('keeps an explicit nutrients[] literal: no fill, no substitutions', async () => {
    const result = await compare({ nutrients: [1008, 2000] });

    expect(result.nutrients.find((r) => r.id === 1008)?.values).toEqual([40, null, null, null]);
    expect(result).not.toHaveProperty('substitutions');
    expect(result.missingData).toEqual([
      { fdcId: 2, nutrientId: 1008 },
      { fdcId: 3, nutrientId: 1008 },
      { fdcId: 4, nutrientId: 1008 },
      { fdcId: 1, nutrientId: 2000 },
      { fdcId: 2, nutrientId: 2000 },
      { fdcId: 3, nutrientId: 2000 },
    ]);
  });

  it('records no substitutions when every food reports the defaults directly', async () => {
    const result = await compare({}, [
      food(1, [nutrient(1008, 'Energy', 40, 'KCAL'), nutrient(2000, 'Total Sugars', 1, 'G')]),
      food(2, [nutrient(1008, 'Energy', 30, 'KCAL'), nutrient(2000, 'Total Sugars', 2, 'G')]),
    ]);

    expect(result).not.toHaveProperty('substitutions');
  });

  it('lists the fills in content[] and heads each column with its FDC ID', async () => {
    const text = firstText(format(await compare({})));

    expect(text).toContain('| Nutrient | Food 1 (1) | Food 2 (2) | Food 3 (3) | Food 4 (4) |');
    expect(text).toContain('| Energy (KCAL) [ID:1008] | 40 | 50.1235 | 60 | — |');
    expect(text).toContain(
      '**Filled from equivalent nutrients:**\n- FDC ID 2: nutrient 1008 filled from 2048\n- FDC ID 3: nutrient 1008 filled from 2047\n- FDC ID 2: nutrient 2000 filled from 1063',
    );
  });
});

describe('usdaCompareFoods basis disclosure', () => {
  const food = (fdcId: number, extra: { basisUnit?: 'g' | 'ml'; servingSizeUnit?: string }) => ({
    fdcId,
    description: `Food ${fdcId}`,
    dataType: extra.basisUnit === 'g' && !extra.servingSizeUnit ? 'SR Legacy' : 'Branded',
    ...extra,
    nutrients: [nutrient(1008, 'Energy', 100, 'KCAL')],
    portions: [],
  });

  const run = async (
    foods: object[],
    args: { quantity?: number; unit?: 'g' | 'oz' } = {},
    deferredIds: number[] = [],
  ) => {
    const service = await getServiceMock();
    service.getFoodsBatch.mockResolvedValue({ foods, failed: [], deferredIds });
    return runToolContract(usdaCompareFoods, {
      fdcIds: [1, 2, 3, ...deferredIds],
      nutrients: [1008],
      ...args,
    });
  };

  it('carries basisUnit and the label unit on each compared food', async () => {
    const result = await run([
      food(1, { basisUnit: 'ml', servingSizeUnit: 'ml' }),
      food(2, { basisUnit: 'g' }),
      food(3, { servingSizeUnit: 'IU' }),
    ]);
    const foods = (result.structuredContent as { foods: Array<Record<string, unknown>> }).foods;

    expect(foods.map((f) => [f.fdcId, f.basisUnit, f.servingSizeUnit])).toEqual([
      [1, 'ml', 'ml'],
      [2, 'g', undefined],
      [3, undefined, 'IU'],
    ]);
    expect(Object.hasOwn(foods[2] ?? {}, 'basisUnit')).toBe(false);
    const text = allText(result.content);
    expect(text).toContain(
      '- **Food 1** (FDC ID: 1, type: Branded, label unit: ml, basis: per 100 ml)',
    );
    expect(text).toContain('- **Food 2** (FDC ID: 2, type: SR Legacy, basis: per 100g)');
    expect(text).toContain(
      '- **Food 3** (FDC ID: 3, type: Branded, label unit: IU, basis: per 100 IU label units (basis unverified))',
    );
  });

  it('names every non-gram food in one notice, on both surfaces, in column order', async () => {
    const result = await run(
      [
        food(1, { basisUnit: 'ml', servingSizeUnit: 'ml' }),
        food(2, { basisUnit: 'g' }),
        food(3, { servingSizeUnit: 'IU' }),
      ],
      { quantity: 15 },
    );
    const notice =
      'FDC ID 1 reports values per 100 ml; its column is per 15 ml, compared without density conversion. FDC ID 3 has an unverified per-100 basis (label unit IU).';

    expect(result.structuredContent).toMatchObject({ notice });
    expect(allText(result.content)).toContain(`> ${notice}`);
  });

  it('puts the deferral ahead of the basis caveat, in one notice on both surfaces', async () => {
    const result = await run(
      [
        food(1, { basisUnit: 'ml', servingSizeUnit: 'ml' }),
        food(2, { basisUnit: 'g' }),
        food(3, { basisUnit: 'g' }),
      ],
      {},
      [4, 5],
    );
    const notice =
      "2 of the 5 FDC IDs (4, 5) went unanswered: FDC did not return them before this call's deadline or kept failing, so the comparison leaves them out; fetch them one at a time with usda_get_food, or call usda_compare_foods again. FDC ID 1 reports values per 100 ml; its column is per 100 ml, compared without density conversion.";

    expect(result.structuredContent).toMatchObject({ deferredIds: [4, 5], notice });
    expect((result.structuredContent as { foods: object[] }).foods).toHaveLength(3);
    const text = allText(result.content);
    expect(text).toContain(`> ${notice}`);
    expect(text).toContain('**Deferred (not compared):** 4, 5');
  });

  it('says so when FDC sends no label unit', async () => {
    const result = await run([
      food(1, { basisUnit: 'g' }),
      food(2, {}),
      food(3, { basisUnit: 'g' }),
    ]);

    expect(result.structuredContent).toMatchObject({
      notice: 'FDC ID 2 has an unverified per-100 basis (no label unit).',
    });
  });

  it('uses the resolved gram weight for the ml column', async () => {
    const result = await run(
      [food(1, { basisUnit: 'ml', servingSizeUnit: 'MLT' }), food(2, { basisUnit: 'g' })],
      { quantity: 1, unit: 'oz' },
    );

    expect(result.structuredContent).toMatchObject({
      notice:
        'FDC ID 1 reports values per 100 ml; its column is per 28.3495 ml, compared without density conversion.',
    });
  });

  it('adds no notice when every food is per 100 g', async () => {
    const result = await run([
      food(1, { basisUnit: 'g' }),
      food(2, { basisUnit: 'g', servingSizeUnit: 'GRM' }),
    ]);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('escapes a Markdown-active label unit in content[] only', async () => {
    const result = await run([food(1, { servingSizeUnit: '*IU*' }), food(2, { basisUnit: 'g' })]);

    expect(result.structuredContent).toMatchObject({
      notice: 'FDC ID 1 has an unverified per-100 basis (label unit *IU*).',
    });
    const text = allText(result.content);
    expect(text).toContain('> FDC ID 1 has an unverified per-100 basis (label unit \\*IU\\*).');
    expect(text).toContain(
      'label unit: \\*IU\\*, basis: per 100 \\*IU\\* label units (basis unverified)',
    );
  });
});

/** IDs FDC did not return before the call's deadline or kept failing on, which the service defers. */
describe('usdaCompareFoods deferred IDs', () => {
  const RECOVERY =
    'Retry the call once. FDC builds some records slowly (Foundation foods most often); if it fails again, request fewer foods per call or fetch them one at a time with usda_get_food.';

  /** Serves `foods` as per-100 g records, so no basis caveat joins the notice. */
  const serve = async (foods: object[], deferredIds: number[]) => {
    const service = await getServiceMock();
    service.getFoodsBatch.mockResolvedValue({
      foods: foods.map((f) => ({ ...f, basisUnit: 'g' })),
      failed: [],
      deferredIds,
    });
  };

  beforeEach(() => {
    deferrals.add.mockClear();
  });

  it('compares the answered foods and routes a single deferred ID to usda_get_food', async () => {
    await serve([SPINACH, KALE], [999]);
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    await usdaCompareFoods.handler(
      usdaCompareFoods.input.parse({ fdcIds: [168462, 168421, 999] }),
      ctx,
    );
    // Nothing is past the cap, so neither the cap's log notice nor its counter fires.
    expect(loggedNotices(ctx)).toEqual([]);

    const result = await runToolContract(usdaCompareFoods, { fdcIds: [168462, 168421, 999] });
    const notice =
      "1 of the 3 FDC IDs (999) went unanswered: FDC did not return it before this call's deadline or kept failing, so the comparison leaves it out; fetch it with usda_get_food (fdcId 999), or call usda_compare_foods again.";

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      foods: [{ fdcId: 168462 }, { fdcId: 168421 }],
      deferredIds: [999],
      notice,
    });
    // A deferred ID is not a missing food.
    const { missingData } = result.structuredContent as { missingData?: Array<{ fdcId: number }> };
    expect(missingData?.map((m) => m.fdcId)).not.toContain(999);
    const text = allText(result.content);
    expect(text).toContain(`> ${notice}`);
    expect(text).toContain('**Deferred (not compared):** 999');
    expect(deferrals.add).not.toHaveBeenCalled();
  });

  it('omits deferredIds, the notice, and the content line when FDC answered every ID', async () => {
    await serve([SPINACH, KALE], []);
    const result = await runToolContract(usdaCompareFoods, { fdcIds: [168462, 168421] });

    expect(result.structuredContent).not.toHaveProperty('deferredIds');
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(allText(result.content)).not.toContain('Deferred');
  });

  it('fails with retry_deadline_exceeded, not too_few_foods, when deferrals leave fewer than 2 foods', async () => {
    await serve([SPINACH], [168421]);
    const result = await runToolContract(usdaCompareFoods, { fdcIds: [168462, 168421] });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.Timeout,
        message:
          "Only 1 of 2 FDC IDs returned data: FDC did not return 168421 before this call's deadline or kept failing.",
        data: {
          reason: 'retry_deadline_exceeded',
          deferredIds: [168421],
          recovery: { hint: RECOVERY },
        },
      },
    });
    expect(allText(result.content)).toContain(RECOVERY);
  });

  it('fails with too_few_foods when even an answer for every deferred ID leaves fewer than 2 foods', async () => {
    const service = await getServiceMock();
    service.getFoodsBatch.mockResolvedValue({
      foods: [],
      failed: [{ fdcId: 999, error: 'Not found.' }],
      deferredIds: [168421],
    });
    const result = await runToolContract(usdaCompareFoods, { fdcIds: [999, 168421] });
    const message =
      "Only 0 of 2 FDC IDs returned data; FDC has no data for 999. FDC did not return 168421 before this call's deadline or kept failing.";

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message,
        data: { reason: 'too_few_foods', deferredIds: [168421] },
      },
    });
    expect(allText(result.content)).toContain(message);
  });

  it('carries the recovery hint on both surfaces when the service fails the call at the deadline', async () => {
    const service = await getServiceMock();
    service.getFoodsBatch.mockRejectedValue(
      timeout('FDC /foods request exceeded its 45000ms retry deadline after 3 attempts.', {
        reason: 'retry_deadline_exceeded',
        deadlineMs: 45_000,
        retryAttempts: 3,
      }),
    );
    const result = await runToolContract(usdaCompareFoods, { fdcIds: [168462, 168421] });

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'retry_deadline_exceeded', recovery: { hint: RECOVERY } },
      },
    });
    expect(allText(result.content)).toContain(RECOVERY);
  });
});

const TOO_FEW_RECOVERY =
  'Verify IDs using usda_search_foods; a comparison needs at least 2 distinct, valid FDC IDs.';

/** A per-100 g food reporting iron, so no basis caveat joins a notice. */
const foodFor = (fdcId: number) => ({
  fdcId,
  description: `Food ${fdcId}`,
  dataType: 'SR Legacy',
  basisUnit: 'g' as const,
  nutrients: [nutrient(1089, 'Iron, Fe', 1, 'MG')],
  portions: [],
});

/**
 * Serves each requested ID once per occurrence, as getFoodsBatch does: a food,
 * a failed entry for an `unknown` ID, or a deferral for an `unanswered` one.
 * Resets the mock first, so its call history is the calling test's alone.
 */
async function answering({
  unknown = [],
  unanswered = [],
}: {
  unknown?: number[];
  unanswered?: number[];
} = {}) {
  const service = await getServiceMock();
  service.getFoodsBatch.mockReset();
  service.getFoodsBatch.mockImplementation(async (fdcIds: number[]) => ({
    foods: fdcIds.filter((id) => !unknown.includes(id) && !unanswered.includes(id)).map(foodFor),
    failed: fdcIds
      .filter((id) => unknown.includes(id))
      .map((fdcId) => ({ fdcId, error: `FDC ID ${fdcId} not found or returned no data.` })),
    deferredIds: unanswered.filter((id) => fdcIds.includes(id)),
  }));
  return service;
}

/** The notice-level log records a call wrote. */
const loggedNotices = (ctx: ReturnType<typeof createMockContext>) =>
  (ctx.log as MockContextLogger).calls.filter((c) => c.level === 'notice');

/**
 * A repeat adds no food and no row: repeats are dropped before anything else,
 * so `[X, X]` cannot clear the two-food minimum that `[X, unknown]` fails.
 */
describe('usdaCompareFoods repeated IDs', () => {
  beforeEach(() => {
    deferrals.add.mockClear();
  });

  it.each([168462, 999_999_901])(
    'fails too_few_foods before any FDC request when fdcIds holds only %i',
    async (id) => {
      const service = await answering({ unknown: [999_999_901] });
      const result = await runToolContract(usdaCompareFoods, {
        fdcIds: [id, id],
        nutrients: [1089, 1089],
      });
      const message = `fdcIds holds 1 distinct FDC ID (${id}); a comparison needs at least 2.`;

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message,
          data: { reason: 'too_few_foods', recovery: { hint: TOO_FEW_RECOVERY } },
        },
      });
      const text = allText(result.content);
      expect(text).toContain(message);
      expect(text).toContain(TOO_FEW_RECOVERY);
      expect(service.getFoodsBatch).not.toHaveBeenCalled();
    },
  );

  it('fails too_few_foods naming the unknown ID when a repeat was the only second food', async () => {
    const service = await answering({ unknown: [999_999_901] });
    const result = await runToolContract(usdaCompareFoods, {
      fdcIds: [168462, 168462, 999_999_901],
      nutrients: [1089],
    });
    const message = 'Only 1 of 2 FDC IDs returned data; FDC has no data for 999999901.';

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message,
        data: { reason: 'too_few_foods', recovery: { hint: TOO_FEW_RECOVERY } },
      },
    });
    expect(allText(result.content)).toContain(message);
    expect(service.getFoodsBatch).toHaveBeenCalledExactlyOnceWith(
      [168462, 999_999_901],
      [1089],
      expect.anything(),
    );
  });

  it('compares each distinct food and nutrient once, from one request for the distinct IDs', async () => {
    const service = await answering();
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const result = await usdaCompareFoods.handler(
      usdaCompareFoods.input.parse({ fdcIds: [168462, 168462, 168421], nutrients: [1089, 1089] }),
      ctx,
    );

    expect(service.getFoodsBatch).toHaveBeenCalledExactlyOnceWith([168462, 168421], [1089], ctx);
    expect(result.foods.map((f) => f.fdcId)).toEqual([168462, 168421]);
    expect(result.nutrients).toHaveLength(1);
    expect(result.nutrients[0]).toMatchObject({ id: 1089, values: [1, 1] });
    const text = firstText(format(result));
    expect(text).toContain('| Nutrient | Food 168462 (168462) | Food 168421 (168421) |');
    expect(text.match(/\[ID:1089\]/g)).toHaveLength(1);
    expect(text.match(/- \*\*Food 168462\*\*/g)).toHaveLength(1);
  });

  it('lists a repeated nutrient a food lacks once in missingData', async () => {
    const service = await getServiceMock();
    service.getFoodsBatch.mockReset();
    service.getFoodsBatch.mockResolvedValue({
      foods: [
        {
          ...foodFor(168462),
          nutrients: [
            nutrient(1089, 'Iron, Fe', 2.71, 'MG'),
            nutrient(1162, 'Vitamin C, total ascorbic acid', 28.1, 'MG'),
          ],
        },
        foodFor(168421),
      ],
      failed: [],
      deferredIds: [],
    });
    const result = await runToolContract(usdaCompareFoods, {
      fdcIds: [168462, 168421],
      nutrients: [1162, 1089, 1162],
    });
    const content = result.structuredContent as { nutrients: object[]; missingData: object[] };

    expect(content.nutrients).toMatchObject([
      { id: 1162, values: [28.1, null] },
      { id: 1089, values: [2.71, 1] },
    ]);
    expect(content.missingData).toEqual([{ fdcId: 168421, nutrientId: 1162 }]);
    expect(allText(result.content)).toContain('- FDC ID 168421: missing nutrients 1162\n');
  });

  it('compares 6+ entries holding at most 5 distinct IDs with nothing deferred', async () => {
    const service = await answering();
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const fdcIds = [1, 2, 3, 1, 4, 5, 2, 3];
    const result = await usdaCompareFoods.handler(usdaCompareFoods.input.parse({ fdcIds }), ctx);

    expect(service.getFoodsBatch).toHaveBeenCalledExactlyOnceWith(ids(5), expect.any(Array), ctx);
    expect(result.foods.map((f) => f.fdcId)).toEqual(ids(5));
    expect(Object.hasOwn(result, 'deferredIds')).toBe(false);
    expect(loggedNotices(ctx)).toEqual([]);
    expect(deferrals.add).not.toHaveBeenCalled();
    const contract = await runToolContract(usdaCompareFoods, { fdcIds });
    expect(contract.structuredContent).not.toHaveProperty('notice');
  });
});

/**
 * A comparison holds 5 foods. Distinct IDs past the fifth are never requested:
 * they count toward neither the two-food minimum nor the deadline test, never
 * replace an unknown ID, and come back in deferredIds after any unanswered IDs.
 */
describe('usdaCompareFoods IDs past the comparison cap', () => {
  beforeEach(() => {
    deferrals.add.mockClear();
  });

  it('creates its deferral counter as usda.compare.deferrals, counted in {calls}', () => {
    expect(deferrals.created).toContainEqual([
      'usda.compare.deferrals',
      expect.any(String),
      '{calls}',
    ]);
  });

  it.each([2, 5])('leaves %i distinct IDs without repeats alone', async (count) => {
    const service = await answering();
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const result = await usdaCompareFoods.handler(
      usdaCompareFoods.input.parse({ fdcIds: ids(count), nutrients: [1089] }),
      ctx,
    );

    expect(service.getFoodsBatch).toHaveBeenCalledExactlyOnceWith(ids(count), [1089], ctx);
    expect(result.foods.map((f) => f.fdcId)).toEqual(ids(count));
    expect(Object.hasOwn(result, 'deferredIds')).toBe(false);
    expect(loggedNotices(ctx)).toEqual([]);
    expect(deferrals.add).not.toHaveBeenCalled();
  });

  it('requests only the first 5 of 7 distinct IDs, defers the last 2, and logs and counts it', async () => {
    const service = await answering();
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const result = await usdaCompareFoods.handler(
      usdaCompareFoods.input.parse({ fdcIds: [...ids(7), 3], nutrients: [1089] }),
      ctx,
    );

    expect(service.getFoodsBatch).toHaveBeenCalledExactlyOnceWith(ids(5), [1089], ctx);
    expect(result.foods.map((f) => f.fdcId)).toEqual(ids(5));
    expect(result.deferredIds).toEqual([6, 7]);
    expect(Object.hasOwn(result, 'missingData')).toBe(false);
    const notices = loggedNotices(ctx);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.data).toMatchObject({ requested: 8, distinct: 7, fetched: 5, deferred: 2 });
    expect(deferrals.add).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('gives the deferred count and a follow-up comparing them, on both surfaces', async () => {
    await answering();
    const result = await runToolContract(usdaCompareFoods, { fdcIds: ids(7), nutrients: [1089] });
    const notice =
      'A comparison holds at most 5 foods: this one took the first 5 of 7 distinct FDC IDs and left 2 unrequested; call usda_compare_foods with the 2 IDs in deferredIds and the same nutrients, quantity, and unit.';

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ deferredIds: [6, 7], notice });
    const text = allText(result.content);
    expect(text).toContain(`> ${notice}`);
    expect(text).toContain('**Deferred (not compared):** 6, 7');
  });

  /**
   * usda_compare_foods takes at least 2 IDs, so one deferred ID is paired with
   * a compared one, keeping this table's rows and basis.
   */
  it('pairs a single ID past the cap with the first compared food, on the same rows and basis', async () => {
    await answering();
    const result = await runToolContract(usdaCompareFoods, { fdcIds: ids(6), nutrients: [1089] });

    expect(result.structuredContent).toMatchObject({
      deferredIds: [6],
      notice:
        'A comparison holds at most 5 foods: this one took the first 5 of 6 distinct FDC IDs and left 1 unrequested; to compare the 1 ID in deferredIds on the same rows and basis, call usda_compare_foods with fdcIds [1, 6] and the same nutrients, quantity, and unit.',
    });
  });

  it('pairs the single leftover with the first food that returned data, not the first requested ID', async () => {
    await answering({ unknown: [1] });
    const result = await runToolContract(usdaCompareFoods, { fdcIds: ids(6), nutrients: [1089] });
    const notice =
      'A comparison holds at most 5 foods: this one took the first 5 of 6 distinct FDC IDs and left 1 unrequested; to compare the 1 ID in deferredIds on the same rows and basis, call usda_compare_foods with fdcIds [2, 6] and the same nutrients, quantity, and unit.';

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      foods: [{ fdcId: 2 }, { fdcId: 3 }, { fdcId: 4 }, { fdcId: 5 }],
      missingData: [{ fdcId: 1, nutrientId: null }],
      deferredIds: [6],
      notice,
    });
    const text = allText(result.content);
    // content[] escapes the brackets, which CommonMark reads back as written.
    expect(text).toContain(
      '> A comparison holds at most 5 foods: this one took the first 5 of 6 distinct FDC IDs and left 1 unrequested; to compare the 1 ID in deferredIds on the same rows and basis, call usda_compare_foods with fdcIds \\[2, 6\\] and the same nutrients, quantity, and unit.',
    );
    expect(text).toContain('**Deferred (not compared):** 6');
  });

  it('lists an unanswered ID ahead of those past the cap, and the notice tells the two apart', async () => {
    const service = await answering({ unanswered: [3] });
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const result = await usdaCompareFoods.handler(
      usdaCompareFoods.input.parse({ fdcIds: ids(7), nutrients: [1089] }),
      ctx,
    );

    expect(service.getFoodsBatch).toHaveBeenCalledExactlyOnceWith(ids(5), [1089], ctx);
    expect(result.foods.map((f) => f.fdcId)).toEqual([1, 2, 4, 5]);
    expect(result.deferredIds).toEqual([3, 6, 7]);
    // The log and the counter record only the IDs past the cap.
    expect(loggedNotices(ctx)[0]?.data).toMatchObject({ deferred: 2 });
    expect(deferrals.add).toHaveBeenCalledExactlyOnceWith(1);

    const contract = await runToolContract(usdaCompareFoods, { fdcIds: ids(7), nutrients: [1089] });
    const notice =
      "A comparison holds at most 5 foods: this one took the first 5 of 7 distinct FDC IDs and left 2 unrequested; 1 of the 5 (3) went unanswered: FDC did not return it before this call's deadline or kept failing, so the comparison leaves it out; call usda_compare_foods with the 3 IDs in deferredIds and the same nutrients, quantity, and unit, or fetch the unanswered one with usda_get_food.";
    expect(contract.structuredContent).toMatchObject({ deferredIds: [3, 6, 7], notice });
    const text = allText(contract.content);
    expect(text).toContain(`> ${notice}`);
    expect(text).toContain('**Deferred (not compared):** 3, 6, 7');
  });

  it('routes several unanswered IDs one at a time beside the compare follow-up', async () => {
    await answering({ unanswered: [2, 4] });
    const result = await runToolContract(usdaCompareFoods, { fdcIds: ids(6), nutrients: [1089] });

    expect(result.structuredContent).toMatchObject({
      foods: [{ fdcId: 1 }, { fdcId: 3 }, { fdcId: 5 }],
      deferredIds: [2, 4, 6],
      notice:
        "A comparison holds at most 5 foods: this one took the first 5 of 6 distinct FDC IDs and left 1 unrequested; 2 of the 5 (2, 4) went unanswered: FDC did not return them before this call's deadline or kept failing, so the comparison leaves them out; call usda_compare_foods with the 3 IDs in deferredIds and the same nutrients, quantity, and unit, or fetch the unanswered ones one at a time with usda_get_food.",
    });
  });

  it('keeps the same rows and basis in the follow-up ahead of the one-at-a-time route for 2 unanswered of 7', async () => {
    await answering({ unanswered: [2, 4] });
    const result = await runToolContract(usdaCompareFoods, { fdcIds: ids(7), nutrients: [1089] });
    const notice =
      "A comparison holds at most 5 foods: this one took the first 5 of 7 distinct FDC IDs and left 2 unrequested; 2 of the 5 (2, 4) went unanswered: FDC did not return them before this call's deadline or kept failing, so the comparison leaves them out; call usda_compare_foods with the 4 IDs in deferredIds and the same nutrients, quantity, and unit, or fetch the unanswered ones one at a time with usda_get_food.";

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      foods: [{ fdcId: 1 }, { fdcId: 3 }, { fdcId: 5 }],
      deferredIds: [2, 4, 6, 7],
      notice,
    });
    const text = allText(result.content);
    expect(text).toContain(`> ${notice}`);
    expect(text).toContain('**Deferred (not compared):** 2, 4, 6, 7');
  });

  it('never requests an ID past the cap to replace an unknown one', async () => {
    const service = await answering({ unknown: [2, 4] });
    const result = await runToolContract(usdaCompareFoods, { fdcIds: ids(6), nutrients: [1089] });

    expect(service.getFoodsBatch).toHaveBeenCalledExactlyOnceWith(
      ids(5),
      [1089],
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({
      foods: [{ fdcId: 1 }, { fdcId: 3 }, { fdcId: 5 }],
      missingData: [
        { fdcId: 2, nutrientId: null },
        { fdcId: 4, nutrientId: null },
      ],
      deferredIds: [6],
    });
  });

  it('fails retry_deadline_exceeded naming the unanswered ID, then the one past the cap, when the first 5 hold 1 food', async () => {
    await answering({ unknown: [1, 2, 3], unanswered: [4] });
    const result = await runToolContract(usdaCompareFoods, { fdcIds: ids(6), nutrients: [1089] });
    const message =
      "Only 1 of 5 FDC IDs returned data: FDC did not return 4 before this call's deadline or kept failing. 6 was past the first 5 and never requested.";

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.Timeout,
        message,
        data: { reason: 'retry_deadline_exceeded', deferredIds: [4, 6] },
      },
    });
    expect(allText(result.content)).toContain(message);
  });

  it('fails too_few_foods naming the unknown IDs, then those past the cap, when only IDs past the cap could add a food', async () => {
    await answering({ unknown: [1, 2, 3, 4] });
    const result = await runToolContract(usdaCompareFoods, { fdcIds: ids(7), nutrients: [1089] });
    const message =
      'Only 1 of 5 FDC IDs returned data; FDC has no data for 1, 2, 3, 4. 6, 7 were past the first 5 and never requested; call usda_compare_foods again without the IDs FDC has no data for.';

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message,
        data: {
          reason: 'too_few_foods',
          deferredIds: [6, 7],
          recovery: { hint: TOO_FEW_RECOVERY },
        },
      },
    });
    expect(allText(result.content)).toContain(message);
  });

  it('fails too_few_foods naming the unanswered ID before the one past the cap', async () => {
    await answering({ unknown: [1, 2, 3, 4], unanswered: [5] });
    const result = await runToolContract(usdaCompareFoods, { fdcIds: ids(6), nutrients: [1089] });
    const message =
      "Only 0 of 5 FDC IDs returned data; FDC has no data for 1, 2, 3, 4. FDC did not return 5 before this call's deadline or kept failing. 6 was past the first 5 and never requested; call usda_compare_foods again without the IDs FDC has no data for.";

    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message,
        data: { reason: 'too_few_foods', deferredIds: [5, 6] },
      },
    });
    expect(allText(result.content)).toContain(message);
  });
});

describe('usdaCompareFoods under USDA_CLAMP_LIMITS', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** A fresh copy of the tool, so its config reads the stubbed variable. */
  async function loadWith(value: string) {
    vi.stubEnv('USDA_CLAMP_LIMITS', value);
    vi.resetModules();
    return (await import('@/mcp-server/tools/definitions/usda-compare-foods.tool.js'))
      .usdaCompareFoods;
  }

  it('false rejects 6 entries as invalid_arguments naming 5, counting entries, not distinct IDs', async () => {
    const strict = await loadWith('false');

    for (const fdcIds of [ids(6), [1, 2, 3, 4, 5, 1]]) {
      const result = await runToolContract(strict, { fdcIds });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
      });
      expect(firstText(result.content)).toContain(
        'fdcIds: Too big: expected array to have <=5 items',
      );
    }
  });

  it('false still accepts 5 entries and rejects 501 naming the 5-entry bound', async () => {
    const strict = await loadWith('false');

    expect(strict.input.parse({ fdcIds: ids(5) }).fdcIds).toHaveLength(5);
    expect(
      strict.input.safeParse({ fdcIds: ids(501) }).error?.issues.map((i) => i.message),
    ).toEqual(['Too big: expected array to have <=5 items']);
    const text = firstText((await runToolContract(strict, { fdcIds: ids(501) })).content);
    expect(text).toContain('fdcIds: Too big: expected array to have <=5 items');
    expect(text).not.toContain('<=500');
  });

  it('advertises the same input schema whatever the variable says', async () => {
    const strict = z.toJSONSchema((await loadWith('false')).input);
    const lenient = z.toJSONSchema((await loadWith('true')).input);

    expect(strict.properties?.fdcIds).toMatchObject({ maxItems: 500 });
    expect(strict).toEqual(lenient);
  });

  it.each(['true', ''])('%j accepts 6 entries and names 500 for 501', async (value) => {
    const tool = await loadWith(value);

    expect(tool.input.safeParse({ fdcIds: ids(6) }).success).toBe(true);
    expect(tool.input.safeParse({ fdcIds: ids(501) }).error?.issues.map((i) => i.message)).toEqual([
      'Too big: expected array to have <=500 items',
    ]);
  });
});
