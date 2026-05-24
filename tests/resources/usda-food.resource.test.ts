/**
 * @fileoverview Tests for usda_food resource (usda://food/{fdcId}).
 * @module tests/resources/usda-food.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usdaFoodResource } from '@/mcp-server/resources/definitions/usda-food.resource.js';

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
  return getFdcService() as { getFoodDetail: ReturnType<typeof vi.fn> };
}

const MOCK_FOOD_DETAIL = {
  fdcId: 171077,
  description: 'Chicken breast raw',
  dataType: 'SR Legacy',
  nutrients: [{ id: 1003, name: 'Protein', number: '203', amount: 22.5, unit: 'G' }],
  portions: [],
};

describe('usdaFoodResource', () => {
  beforeEach(async () => {
    const service = await getServiceMock();
    service.getFoodDetail.mockResolvedValue(MOCK_FOOD_DETAIL);
  });

  it('returns food detail for a valid FDC ID', async () => {
    const ctx = createMockContext({ errors: usdaFoodResource.errors });
    const params = usdaFoodResource.params.parse({ fdcId: '171077' });
    const result = await usdaFoodResource.handler(params, ctx);

    expect(result).toMatchObject({
      fdcId: 171077,
      description: 'Chicken breast raw',
    });
  });

  it('throws ctx.fail("invalid_id") for non-numeric fdcId', async () => {
    const ctx = createMockContext({ errors: usdaFoodResource.errors });
    const params = usdaFoodResource.params.parse({ fdcId: 'abc' });

    await expect(usdaFoodResource.handler(params, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id' },
    });
  });

  it('throws ctx.fail("invalid_id") for zero fdcId', async () => {
    const ctx = createMockContext({ errors: usdaFoodResource.errors });
    const params = usdaFoodResource.params.parse({ fdcId: '0' });

    await expect(usdaFoodResource.handler(params, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id' },
    });
  });

  it('throws ctx.fail("not_found") when service returns 404 error', async () => {
    const service = await getServiceMock();
    service.getFoodDetail.mockRejectedValue(new Error('404 Not Found'));
    const ctx = createMockContext({ errors: usdaFoodResource.errors });
    const params = usdaFoodResource.params.parse({ fdcId: '999999' });

    await expect(usdaFoodResource.handler(params, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('propagates non-404 service errors', async () => {
    const service = await getServiceMock();
    service.getFoodDetail.mockRejectedValue(new Error('Service unavailable'));
    const ctx = createMockContext({ errors: usdaFoodResource.errors });
    const params = usdaFoodResource.params.parse({ fdcId: '171077' });

    await expect(usdaFoodResource.handler(params, ctx)).rejects.toThrow('Service unavailable');
  });

  it('handles sparse upstream payload with no optional fields', async () => {
    const service = await getServiceMock();
    service.getFoodDetail.mockResolvedValue({
      fdcId: 1,
      description: 'Sparse food',
      dataType: 'SR Legacy',
      nutrients: [],
      portions: [],
    });
    const ctx = createMockContext({ errors: usdaFoodResource.errors });
    const params = usdaFoodResource.params.parse({ fdcId: '1' });
    const result = await usdaFoodResource.handler(params, ctx);

    expect(result).toBeDefined();
    expect((result as { fdcId: number }).fdcId).toBe(1);
  });
});
