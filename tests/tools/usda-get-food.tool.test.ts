/**
 * @fileoverview Tests for usda_get_food tool.
 * @module tests/tools/usda-get-food.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usdaGetFood } from '@/mcp-server/tools/definitions/usda-get-food.tool.js';
import { firstText } from '../helpers.js';

const { format } = usdaGetFood;
if (!format) throw new Error('usda_get_food must declare format()');

vi.mock('@/services/fdc/fdc-service.js', () => {
  const mockService = {
    getFoodDetail: vi.fn(),
  };
  return {
    FdcService: vi.fn(() => mockService),
    getFdcService: vi.fn(() => mockService),
    initFdcService: vi.fn(),
  };
});

async function getServiceMock() {
  const { getFdcService } = await import('@/services/fdc/fdc-service.js');
  return getFdcService() as unknown as { getFoodDetail: ReturnType<typeof vi.fn> };
}

const MOCK_FOOD_DETAIL = {
  fdcId: 171077,
  description: 'Chicken, broilers or fryers, breast, meat only, raw',
  dataType: 'SR Legacy',
  foodCategory: 'Poultry Products',
  publicationDate: '2019-04-01',
  nutrients: [
    { id: 1008, name: 'Energy', number: '208', amount: 120, unit: 'KCAL' },
    { id: 1003, name: 'Protein', number: '203', amount: 22.5, unit: 'G' },
    { id: 1004, name: 'Total lipid (fat)', number: '204', amount: 2.62, unit: 'G' },
  ],
  portions: [{ description: '1 breast', gramWeight: 118 }],
};

describe('usdaGetFood', () => {
  beforeEach(async () => {
    const service = await getServiceMock();
    service.getFoodDetail.mockResolvedValue(MOCK_FOOD_DETAIL);
  });

  it('schema rejects fdcId of 0', () => {
    expect(() => usdaGetFood.input.parse({ fdcId: 0 })).toThrow();
  });

  it('schema rejects negative fdcId', () => {
    expect(() => usdaGetFood.input.parse({ fdcId: -1 })).toThrow();
  });

  it('schema rejects non-positive nutrient IDs', () => {
    expect(() => usdaGetFood.input.parse({ fdcId: 1, nutrients: [-1] })).toThrow();
    expect(() => usdaGetFood.input.parse({ fdcId: 1, nutrients: [0] })).toThrow();
    expect(() => usdaGetFood.input.parse({ fdcId: 1, nutrients: [1008, 0] })).toThrow();
  });

  it('schema accepts positive nutrient IDs and an omitted filter', () => {
    expect(usdaGetFood.input.parse({ fdcId: 1, nutrients: [1008, 1003] }).nutrients).toEqual([
      1008, 1003,
    ]);
    expect(usdaGetFood.input.parse({ fdcId: 1 }).nutrients).toBeUndefined();
  });

  it('schema rejects non-positive quantity', () => {
    expect(() => usdaGetFood.input.parse({ fdcId: 1, quantity: 0, unit: 'g' })).toThrow();
    expect(() => usdaGetFood.input.parse({ fdcId: 1, quantity: -100, unit: 'g' })).toThrow();
  });

  it('throws ctx.fail("quantity_without_unit") when quantity provided without unit', async () => {
    const ctx = createMockContext({ errors: usdaGetFood.errors });
    const input = usdaGetFood.input.parse({ fdcId: 171077, quantity: 200 });
    await expect(usdaGetFood.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'quantity_without_unit' },
    });
  });

  it('returns full nutrient profile for a valid fdcId', async () => {
    const ctx = createMockContext({ errors: usdaGetFood.errors });
    const input = usdaGetFood.input.parse({ fdcId: 171077 });
    const result = await usdaGetFood.handler(input, ctx);

    expect(result.fdcId).toBe(171077);
    expect(result.description).toContain('Chicken');
    expect(result.nutrients.length).toBeGreaterThan(0);
    expect(result.nutrients[0]).toHaveProperty('id');
    expect(result.nutrients[0]).toHaveProperty('amount');
  });

  it('returns per-100g values when no quantity is provided', async () => {
    const ctx = createMockContext({ errors: usdaGetFood.errors });
    const input = usdaGetFood.input.parse({ fdcId: 171077 });
    const result = await usdaGetFood.handler(input, ctx);

    const protein = result.nutrients.find((n) => n.id === 1003);
    expect(protein?.amount).toBeCloseTo(22.5, 2);
    expect(result.scaledTo).toBeUndefined();
  });

  it('scales nutrients when quantity and unit are provided', async () => {
    const ctx = createMockContext({ errors: usdaGetFood.errors });
    const input = usdaGetFood.input.parse({ fdcId: 171077, quantity: 200, unit: 'g' });
    const result = await usdaGetFood.handler(input, ctx);

    // 200g → scaleFactor = 2
    const protein = result.nutrients.find((n) => n.id === 1003);
    expect(protein?.amount).toBeCloseTo(45.0, 1);
    expect(result.scaledTo).toEqual({ quantity: 200, unit: 'g', gramWeight: 200 });
  });

  it('scales to serving weight when unit is "serving"', async () => {
    const ctx = createMockContext({ errors: usdaGetFood.errors });
    const input = usdaGetFood.input.parse({ fdcId: 171077, quantity: 1, unit: 'serving' });
    const result = await usdaGetFood.handler(input, ctx);

    // 1 breast = 118g → scaleFactor = 1.18
    const protein = result.nutrients.find((n) => n.id === 1003);
    expect(protein?.amount).toBeCloseTo(22.5 * 1.18, 1);
    expect(result.scaledTo?.gramWeight).toBe(118);
  });

  it('throws ctx.fail("no_portion_data") when serving requested but no portions', async () => {
    const service = await getServiceMock();
    service.getFoodDetail.mockResolvedValue({ ...MOCK_FOOD_DETAIL, portions: [] });
    const ctx = createMockContext({ errors: usdaGetFood.errors });
    const input = usdaGetFood.input.parse({ fdcId: 171077, quantity: 1, unit: 'serving' });

    await expect(usdaGetFood.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_portion_data' },
    });
  });

  it('throws ctx.fail("not_found") when service returns 404-like error', async () => {
    const service = await getServiceMock();
    service.getFoodDetail.mockRejectedValue(new Error('404 Not Found'));
    const ctx = createMockContext({ errors: usdaGetFood.errors });
    const input = usdaGetFood.input.parse({ fdcId: 999999 });

    await expect(usdaGetFood.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('propagates non-404 service errors', async () => {
    const service = await getServiceMock();
    service.getFoodDetail.mockRejectedValue(new Error('Network timeout'));
    const ctx = createMockContext({ errors: usdaGetFood.errors });
    const input = usdaGetFood.input.parse({ fdcId: 171077 });

    await expect(usdaGetFood.handler(input, ctx)).rejects.toThrow('Network timeout');
  });

  it('includes portion data in result when available', async () => {
    const ctx = createMockContext({ errors: usdaGetFood.errors });
    const input = usdaGetFood.input.parse({ fdcId: 171077 });
    const result = await usdaGetFood.handler(input, ctx);

    expect(result.servingInfo).toEqual({ description: '1 breast', gramWeight: 118 });
    expect(result.allPortions).toHaveLength(1);
  });

  it('handles sparse food with no optional fields', async () => {
    const service = await getServiceMock();
    service.getFoodDetail.mockResolvedValue({
      fdcId: 1,
      description: 'Sparse food',
      dataType: 'SR Legacy',
      nutrients: [],
      portions: [],
    });
    const ctx = createMockContext({ errors: usdaGetFood.errors });
    const input = usdaGetFood.input.parse({ fdcId: 1 });
    const result = await usdaGetFood.handler(input, ctx);

    expect(result.foodCategory).toBeUndefined();
    expect(result.brandOwner).toBeUndefined();
    expect(result.servingInfo).toBeUndefined();
    expect(result.nutrients).toHaveLength(0);
  });

  it('formats output with FDC ID, description, and nutrient list', () => {
    const output = {
      fdcId: 171077,
      description: 'Chicken breast raw',
      dataType: 'SR Legacy',
      nutrients: [{ id: 1003, name: 'Protein', number: '203', amount: 22.5, unit: 'G' }],
    };
    const text = firstText(format(output));
    expect(text).toContain('171077');
    expect(text).toContain('Chicken breast raw');
    expect(text).toContain('1003');
    expect(text).toContain('Protein');
    expect(text).toContain('22.5');
  });

  it('formats scaling basis when scaledTo is present', () => {
    const output = {
      fdcId: 171077,
      description: 'Chicken breast raw',
      dataType: 'SR Legacy',
      scaledTo: { quantity: 200, unit: 'g', gramWeight: 200 },
      nutrients: [],
    };
    const text = firstText(format(output));
    expect(text).toContain('200');
    expect(text).toContain('200.0g');
  });
});
