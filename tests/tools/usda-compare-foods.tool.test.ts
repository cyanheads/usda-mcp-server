/**
 * @fileoverview Tests for usda_compare_foods tool.
 * @module tests/tools/usda-compare-foods.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usdaCompareFoods } from '@/mcp-server/tools/definitions/usda-compare-foods.tool.js';
import { allText, firstText } from '../helpers.js';

const { format } = usdaCompareFoods;
if (!format) throw new Error('usda_compare_foods must declare format()');

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
    service.getFoodsBatch.mockResolvedValue({ foods: [SPINACH, KALE], failed: [] });
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
     * 2–5 foods is the declared window — the table has one column per food, so
     * one past the cap must be refused rather than rendered off the edge.
     */
    it('accepts the smallest and largest declared comparison', () => {
      expect(usdaCompareFoods.input.parse({ fdcIds: [1, 2] }).fdcIds).toHaveLength(2);
      expect(usdaCompareFoods.input.parse({ fdcIds: [1, 2, 3, 4, 5] }).fdcIds).toHaveLength(5);
    });

    it('rejects a single id — a comparison needs something to compare against', () => {
      expect(() => usdaCompareFoods.input.parse({ fdcIds: [168421] })).toThrow();
    });

    it('rejects one past the cap rather than silently dropping a column', () => {
      expect(() => usdaCompareFoods.input.parse({ fdcIds: [1, 2, 3, 4, 5, 6] })).toThrow();
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
    service.getFoodsBatch.mockResolvedValue({ foods: [foodA, foodB], failed: [] });

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
      service.getFoodsBatch.mockResolvedValue({ foods: WITH_TOTAL_SUGARS, failed: [] });
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
    nutrient(1008, 'Energy', 40, 'kcal'),
    nutrient(2048, 'Energy (Atwater Specific Factors)', 41, 'kcal'),
  ]);
  const BOTH_ESTIMATES = food(2, [
    nutrient(2047, 'Energy (Atwater General Factors)', 52, 'kcal'),
    nutrient(2048, 'Energy (Atwater Specific Factors)', 50.12346, 'kcal'),
    nutrient(1063, 'Sugars, Total', 3, 'g'),
  ]);
  const GENERAL_ONLY = food(3, [nutrient(2047, 'Energy (Atwater General Factors)', 60, 'kcal')]);
  const NO_ENERGY = food(4, [nutrient(2000, 'Total Sugars', 2, 'g')]);
  const FOODS = [DIRECT, BOTH_ESTIMATES, GENERAL_ONLY, NO_ENERGY];

  const compare = async (args: { nutrients?: number[]; quantity?: number }, foods = FOODS) => {
    const service = await getServiceMock();
    service.getFoodsBatch.mockResolvedValue({ foods, failed: [] });
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
      unit: 'kcal',
      values: [40, 50.1235, 60, null],
    });
    expect(result.nutrients.find((r) => r.id === 2000)).toEqual({
      id: 2000,
      name: 'Total Sugars',
      unit: 'g',
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
      food(1, [nutrient(1008, 'Energy', 40, 'kcal'), nutrient(2000, 'Total Sugars', 1, 'g')]),
      food(2, [nutrient(1008, 'Energy', 30, 'kcal'), nutrient(2000, 'Total Sugars', 2, 'g')]),
    ]);

    expect(result).not.toHaveProperty('substitutions');
  });

  it('lists the fills in content[] and heads each column with its FDC ID', async () => {
    const text = firstText(format(await compare({})));

    expect(text).toContain('| Nutrient | Food 1 (1) | Food 2 (2) | Food 3 (3) | Food 4 (4) |');
    expect(text).toContain('| Energy (kcal) [ID:1008] | 40 | 50.1235 | 60 | — |');
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
    nutrients: [nutrient(1008, 'Energy', 100, 'kcal')],
    portions: [],
  });

  const run = async (foods: object[], args: { quantity?: number; unit?: 'g' | 'oz' } = {}) => {
    const service = await getServiceMock();
    service.getFoodsBatch.mockResolvedValue({ foods, failed: [] });
    return runToolContract(usdaCompareFoods, { fdcIds: [1, 2, 3], nutrients: [1008], ...args });
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
