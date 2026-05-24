/**
 * @fileoverview Tests for usda_search_foods tool.
 * @module tests/tools/usda-search-foods.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usdaSearchFoods } from '@/mcp-server/tools/definitions/usda-search-foods.tool.js';

// Mock the FDC service module so tests don't hit the network
vi.mock('@/services/fdc/fdc-service.js', () => {
  const mockService = {
    searchFoods: vi.fn(),
  };
  return {
    FdcService: vi.fn(() => mockService),
    getFdcService: vi.fn(() => mockService),
    initFdcService: vi.fn(),
  };
});

async function getServiceMock() {
  const { getFdcService } = await import('@/services/fdc/fdc-service.js');
  return getFdcService() as { searchFoods: ReturnType<typeof vi.fn> };
}

const MOCK_FOOD = {
  fdcId: 171077,
  description: 'Chicken, broilers or fryers, breast, meat only, raw',
  dataType: 'SR Legacy',
  nutrients: [
    { id: 1008, name: 'Energy', amount: 120, unit: 'KCAL' },
    { id: 1003, name: 'Protein', amount: 22.5, unit: 'G' },
  ],
};

const MOCK_SEARCH_RESULT = {
  totalHits: 1,
  currentPage: 1,
  totalPages: 1,
  foods: [MOCK_FOOD],
};

describe('usdaSearchFoods', () => {
  beforeEach(async () => {
    const service = await getServiceMock();
    service.searchFoods.mockResolvedValue(MOCK_SEARCH_RESULT);
  });

  it('returns matching foods for a valid query', async () => {
    const ctx = createMockContext({ errors: usdaSearchFoods.errors });
    const input = usdaSearchFoods.input.parse({ query: 'chicken breast' });
    const result = await usdaSearchFoods.handler(input, ctx);

    expect(result.totalHits).toBe(1);
    expect(result.currentPage).toBe(1);
    expect(result.foods).toHaveLength(1);
    expect(result.foods[0].fdcId).toBe(171077);
    expect(result.foods[0].description).toContain('Chicken');
  });

  it('defaults to SR Legacy when dataType is omitted', async () => {
    const service = await getServiceMock();
    const ctx = createMockContext({ errors: usdaSearchFoods.errors });
    const input = usdaSearchFoods.input.parse({ query: 'banana' });
    await usdaSearchFoods.handler(input, ctx);

    expect(service.searchFoods).toHaveBeenCalledWith(
      expect.objectContaining({ dataType: ['SR Legacy'] }),
      ctx,
    );
  });

  it('passes explicit dataType through', async () => {
    const service = await getServiceMock();
    const ctx = createMockContext({ errors: usdaSearchFoods.errors });
    const input = usdaSearchFoods.input.parse({ query: 'granola', dataType: ['Branded'] });
    await usdaSearchFoods.handler(input, ctx);

    expect(service.searchFoods).toHaveBeenCalledWith(
      expect.objectContaining({ dataType: ['Branded'] }),
      ctx,
    );
  });

  it('passes brandOwner when provided', async () => {
    const service = await getServiceMock();
    const ctx = createMockContext({ errors: usdaSearchFoods.errors });
    const input = usdaSearchFoods.input.parse({
      query: 'oats',
      dataType: ['Branded'],
      brandOwner: 'Quaker',
    });
    await usdaSearchFoods.handler(input, ctx);

    expect(service.searchFoods).toHaveBeenCalledWith(
      expect.objectContaining({ brandOwner: 'Quaker' }),
      ctx,
    );
  });

  it('throws ctx.fail("no_results") when service returns empty foods', async () => {
    const service = await getServiceMock();
    service.searchFoods.mockResolvedValue({
      totalHits: 0,
      currentPage: 1,
      totalPages: 0,
      foods: [],
    });
    const ctx = createMockContext({ errors: usdaSearchFoods.errors });
    const input = usdaSearchFoods.input.parse({ query: 'xyzxyzxyz_no_match' });

    await expect(usdaSearchFoods.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results' },
    });
  });

  it('formats output with totalHits, pagination, and food rows', () => {
    const output = {
      totalHits: 42,
      currentPage: 2,
      totalPages: 5,
      foods: [
        {
          fdcId: 171077,
          description: 'Chicken breast raw',
          dataType: 'SR Legacy',
          nutrients: [{ id: 1008, name: 'Energy', amount: 120, unit: 'KCAL' }],
        },
      ],
    };
    const blocks = usdaSearchFoods.format!(output);
    expect(blocks[0].type).toBe('text');
    const text = blocks[0].text;
    expect(text).toContain('42 total hits');
    expect(text).toContain('page 2 of 5');
    expect(text).toContain('171077');
    expect(text).toContain('Chicken breast raw');
    expect(text).toContain('Energy');
  });

  it('formats branded food with serving info', () => {
    const output = {
      totalHits: 1,
      currentPage: 1,
      totalPages: 1,
      foods: [
        {
          fdcId: 999,
          description: 'Granola Bar',
          dataType: 'Branded',
          brandOwner: 'General Mills',
          brandName: 'Nature Valley',
          servingSize: 42,
          servingSizeUnit: 'g',
          householdServingFullText: '2 bars',
          nutrients: [],
          publishedDate: '2022-01-01',
        },
      ],
    };
    const blocks = usdaSearchFoods.format!(output);
    const text = blocks[0].text;
    expect(text).toContain('General Mills');
    expect(text).toContain('Nature Valley');
    expect(text).toContain('42');
    expect(text).toContain('2022-01-01');
  });

  it('handles sparse upstream payload with no optional fields', async () => {
    const service = await getServiceMock();
    service.searchFoods.mockResolvedValue({
      totalHits: 1,
      currentPage: 1,
      totalPages: 1,
      foods: [{ fdcId: 1, description: 'Plain food', dataType: 'SR Legacy', nutrients: [] }],
    });
    const ctx = createMockContext({ errors: usdaSearchFoods.errors });
    const input = usdaSearchFoods.input.parse({ query: 'plain' });
    const result = await usdaSearchFoods.handler(input, ctx);
    expect(result.foods[0].foodCategory).toBeUndefined();
    expect(result.foods[0].brandOwner).toBeUndefined();
  });
});
