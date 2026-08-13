/**
 * @fileoverview Tests for usda_get_foods (batch) tool.
 * @module tests/tools/usda-get-foods.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usdaGetFoods } from '@/mcp-server/tools/definitions/usda-get-foods.tool.js';
import { firstText } from '../helpers.js';

const { format } = usdaGetFoods;
if (!format) throw new Error('usda_get_foods must declare format()');

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

const MOCK_FOODS = [
  {
    fdcId: 171077,
    description: 'Chicken breast raw',
    dataType: 'SR Legacy',
    nutrients: [{ id: 1003, name: 'Protein', number: '203', amount: 22.5, unit: 'G' }],
    portions: [],
  },
  {
    fdcId: 171079,
    description: 'Chicken thigh raw',
    dataType: 'SR Legacy',
    nutrients: [{ id: 1003, name: 'Protein', number: '203', amount: 17.4, unit: 'G' }],
    portions: [],
  },
];

describe('usdaGetFoods', () => {
  beforeEach(async () => {
    const service = await getServiceMock();
    service.getFoodsBatch.mockResolvedValue({ foods: MOCK_FOODS, failed: [] });
  });

  it('schema rejects non-positive nutrient IDs', () => {
    expect(() => usdaGetFoods.input.parse({ fdcIds: [1, 2], nutrients: [-1] })).toThrow();
    expect(() => usdaGetFoods.input.parse({ fdcIds: [1, 2], nutrients: [0] })).toThrow();
  });

  it('schema accepts positive nutrient IDs and an omitted filter', () => {
    expect(usdaGetFoods.input.parse({ fdcIds: [1, 2], nutrients: [1008, 1003] }).nutrients).toEqual(
      [1008, 1003],
    );
    expect(usdaGetFoods.input.parse({ fdcIds: [1, 2] }).nutrients).toBeUndefined();
  });

  it('returns nutrient profiles for all valid fdcIds', async () => {
    const ctx = createMockContext();
    const input = usdaGetFoods.input.parse({ fdcIds: [171077, 171079] });
    const result = await usdaGetFoods.handler(input, ctx);

    expect(result.foods).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(result.foods[0]?.fdcId).toBe(171077);
    expect(result.foods[1]?.fdcId).toBe(171079);
  });

  it('includes failed IDs in the failed array', async () => {
    const service = await getServiceMock();
    service.getFoodsBatch.mockResolvedValue({
      foods: [MOCK_FOODS[0]],
      failed: [{ fdcId: 999999, error: 'FDC ID 999999 not found or returned no data.' }],
    });
    const ctx = createMockContext();
    const input = usdaGetFoods.input.parse({ fdcIds: [171077, 999999] });
    const result = await usdaGetFoods.handler(input, ctx);

    expect(result.foods).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.fdcId).toBe(999999);
  });

  it('passes nutrient filter to the service', async () => {
    const service = await getServiceMock();
    const ctx = createMockContext();
    const input = usdaGetFoods.input.parse({ fdcIds: [171077, 171079], nutrients: [1003, 1008] });
    await usdaGetFoods.handler(input, ctx);

    expect(service.getFoodsBatch).toHaveBeenCalledWith([171077, 171079], [1003, 1008], ctx);
  });

  it('passes undefined nutrient filter when nutrients are omitted', async () => {
    const service = await getServiceMock();
    const ctx = createMockContext();
    const input = usdaGetFoods.input.parse({ fdcIds: [171077, 171079] });
    await usdaGetFoods.handler(input, ctx);

    expect(service.getFoodsBatch).toHaveBeenCalledWith([171077, 171079], undefined, ctx);
  });

  it('normalizes output to the expected shape', async () => {
    const ctx = createMockContext();
    const input = usdaGetFoods.input.parse({ fdcIds: [171077, 171079] });
    const result = await usdaGetFoods.handler(input, ctx);

    expect(result).toEqual(expect.schemaMatching(usdaGetFoods.output));
    expect(result.foods[0]?.nutrients[0]).toEqual({
      id: 1003,
      name: 'Protein',
      number: '203',
      amount: 22.5,
      unit: 'G',
    });
  });

  it('drops percentDailyValue, which the batch output schema does not carry', async () => {
    const service = await getServiceMock();
    service.getFoodsBatch.mockResolvedValue({
      foods: [
        {
          ...MOCK_FOODS[0],
          nutrients: [
            {
              id: 1003,
              name: 'Protein',
              number: '203',
              amount: 22.5,
              unit: 'G',
              percentDailyValue: 45,
            },
          ],
        },
      ],
      failed: [],
    });
    const ctx = createMockContext();
    const input = usdaGetFoods.input.parse({ fdcIds: [171077, 171079] });
    const result = await usdaGetFoods.handler(input, ctx);

    expect(result.foods[0]?.nutrients[0]).not.toHaveProperty('percentDailyValue');
  });

  it('handles sparse foods with empty nutrient arrays', async () => {
    const service = await getServiceMock();
    service.getFoodsBatch.mockResolvedValue({
      foods: [
        { fdcId: 1, description: 'Sparse', dataType: 'SR Legacy', nutrients: [], portions: [] },
      ],
      failed: [],
    });
    const ctx = createMockContext();
    const input = usdaGetFoods.input.parse({ fdcIds: [1, 2] });
    const result = await usdaGetFoods.handler(input, ctx);
    expect(result.foods).toHaveLength(1);
    expect(result.foods[0]?.nutrients).toHaveLength(0);
  });

  it('formats output with food count, descriptions, and FDC IDs', () => {
    const output = {
      foods: [
        {
          fdcId: 171077,
          description: 'Chicken breast raw',
          dataType: 'SR Legacy',
          nutrients: [{ id: 1003, name: 'Protein', number: '203', amount: 22.5, unit: 'G' }],
        },
      ],
      failed: [{ fdcId: 999, error: 'Not found.' }],
    };
    const text = firstText(format(output));
    expect(text).toContain('1 foods fetched');
    expect(text).toContain('1 failed');
    expect(text).toContain('171077');
    expect(text).toContain('Chicken breast raw');
    expect(text).toContain('1003');
    expect(text).toContain('999');
  });
});
