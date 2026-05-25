/**
 * @fileoverview Tests for usda_compare_foods tool.
 * @module tests/tools/usda-compare-foods.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usdaCompareFoods } from '@/mcp-server/tools/definitions/usda-compare-foods.tool.js';

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
  return getFdcService() as { getFoodsBatch: ReturnType<typeof vi.fn> };
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

describe('usdaCompareFoods', () => {
  beforeEach(async () => {
    const service = await getServiceMock();
    service.getFoodsBatch.mockResolvedValue({ foods: [SPINACH, KALE], failed: [] });
  });

  it('schema rejects fdcIds containing 0 or negative values', () => {
    expect(() => usdaCompareFoods.input.parse({ fdcIds: [0, 168421] })).toThrow();
    expect(() => usdaCompareFoods.input.parse({ fdcIds: [-1, 168421] })).toThrow();
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
    const blocks = usdaCompareFoods.format!(output);
    expect(blocks[0].type).toBe('text');
    const text = blocks[0].text;
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
    const blocks = usdaCompareFoods.format!(output);
    const text = blocks[0].text;
    expect(text).toContain('Missing data');
    expect(text).toContain('999');
    expect(text).toContain('1162');
  });
});
