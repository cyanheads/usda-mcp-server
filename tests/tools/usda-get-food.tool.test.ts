/**
 * @fileoverview Tests for usda_get_food tool.
 * @module tests/tools/usda-get-food.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usdaGetFood } from '@/mcp-server/tools/definitions/usda-get-food.tool.js';
import { createFdcFake } from '../fdc-fake.js';
import { firstText } from '../helpers.js';

/**
 * The McpError `fetchWithTimeout` throws for a non-2xx FDC response: the
 * status-mapped code, plus `status` and its legacy `statusCode` alias.
 */
function fdcHttpError(status: number, message: string): McpError {
  return new McpError(
    status === 404 ? JsonRpcErrorCode.NotFound : JsonRpcErrorCode.ServiceUnavailable,
    message,
    {
      status,
      statusText: status === 404 ? 'Not Found' : 'Service Unavailable',
      body: '{"error":{"code":"NOT_FOUND"}}',
      statusCode: status,
      responseBody: '{"error":{"code":"NOT_FOUND"}}',
      errorSource: 'FetchHttpError',
    },
  );
}

let http: FetchMockHarness;

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

  /**
   * `unit` alone takes a default quantity (1 serving, 100 of a mass unit), and
   * `quantity` multiplies a serving. The basis applied is always the one
   * `scaledTo` names, so no call returns values for an amount it does not show.
   */
  describe('quantity defaults and serving multiples', () => {
    const protein = (result: { nutrients: Array<{ id: number; amount: number }> }) =>
      result.nutrients.find((n) => n.id === 1003)?.amount;

    it('multiplies the first portion weight by quantity for unit="serving"', async () => {
      const ctx = createMockContext({ errors: usdaGetFood.errors });
      const input = usdaGetFood.input.parse({ fdcId: 171077, quantity: 2, unit: 'serving' });
      const result = await usdaGetFood.handler(input, ctx);

      // 2 × 118 g breast = 236 g → scaleFactor 2.36
      expect(result.scaledTo).toEqual({ quantity: 2, unit: 'serving', gramWeight: 236 });
      expect(protein(result)).toBe(53.1);
    });

    it('takes a fractional serving', async () => {
      const ctx = createMockContext({ errors: usdaGetFood.errors });
      const input = usdaGetFood.input.parse({ fdcId: 171077, quantity: 0.5, unit: 'serving' });
      const result = await usdaGetFood.handler(input, ctx);

      expect(result.scaledTo).toEqual({ quantity: 0.5, unit: 'serving', gramWeight: 59 });
      expect(protein(result)).toBe(13.275);
    });

    it('defaults unit="serving" alone to one serving', async () => {
      const ctx = createMockContext({ errors: usdaGetFood.errors });
      const input = usdaGetFood.input.parse({ fdcId: 171077, unit: 'serving' });
      const result = await usdaGetFood.handler(input, ctx);

      expect(result.scaledTo).toEqual({ quantity: 1, unit: 'serving', gramWeight: 118 });
      expect(protein(result)).toBe(26.55);
    });

    it.each([
      ['g', 100, 22.5],
      ['oz', 2834.95, 637.8637],
      ['lb', 45359.2, 10205.82],
      ['kg', 100000, 22500],
    ] as const)(
      'defaults unit="%s" alone to quantity 100 (%s g)',
      async (unit, gramWeight, amount) => {
        const ctx = createMockContext({ errors: usdaGetFood.errors });
        const input = usdaGetFood.input.parse({ fdcId: 171077, unit });
        const result = await usdaGetFood.handler(input, ctx);

        expect(result.scaledTo).toEqual({ quantity: 100, unit, gramWeight });
        expect(protein(result)).toBe(amount);
      },
    );

    it('rounds a mass conversion to the same 4 decimals as nutrient amounts', async () => {
      const ctx = createMockContext({ errors: usdaGetFood.errors });
      // 3 × 28.3495 is 85.04849999999999 in binary floating point
      const input = usdaGetFood.input.parse({ fdcId: 171077, quantity: 3, unit: 'oz' });
      const result = await usdaGetFood.handler(input, ctx);

      expect(result.scaledTo).toEqual({ quantity: 3, unit: 'oz', gramWeight: 85.0485 });
    });

    it('renders the basis line with the exact gram weight scaledTo carries', async () => {
      const ctx = createMockContext({ errors: usdaGetFood.errors });
      const result = await usdaGetFood.handler(
        usdaGetFood.input.parse({ fdcId: 171077, quantity: 3, unit: 'oz' }),
        ctx,
      );
      const lines = firstText(format(result)).split('\n');

      expect(lines.filter((line) => line.startsWith('**Basis:**'))).toEqual([
        '**Basis:** 3 oz (85.0485g)',
      ]);
    });
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

  it('throws ctx.fail("not_found") when the service throws its HTTP 404 McpError', async () => {
    const service = await getServiceMock();
    const upstream = fdcHttpError(
      404,
      'Fetch failed for https://api.example/food/999999. Status: 404',
    );
    service.getFoodDetail.mockRejectedValue(upstream);
    const ctx = createMockContext({ errors: usdaGetFood.errors });
    const input = usdaGetFood.input.parse({ fdcId: 999999 });

    const err = await Promise.resolve(usdaGetFood.handler(input, ctx)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: 'FDC ID 999999 not found.',
      data: { reason: 'not_found', fdcId: 999999 },
    });
    // The upstream error rides as cause for the server log, never in data
    expect((err as McpError).cause).toBe(upstream);
    expect((err as McpError).data).not.toHaveProperty('status');
  });

  /**
   * not_found is decided by the structured status the service's HTTP error
   * carries, never by message wording — a reworded upstream message must not
   * drop the reason, and an unrelated failure that says "not found" must not
   * be reported as a missing food.
   */
  describe('not_found classification', () => {
    it('maps a status-404 McpError whose message never says 404 or not found', async () => {
      const service = await getServiceMock();
      service.getFoodDetail.mockRejectedValue(fdcHttpError(404, 'No such food'));

      const result = await runToolContract(usdaGetFood, { fdcId: 1 });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message: 'FDC ID 1 not found.',
          data: {
            reason: 'not_found',
            recovery: {
              hint: 'Verify the FDC ID using usda_search_foods and try again with a valid ID.',
            },
          },
        },
      });
      expect(firstText(result.content)).toContain(
        'Verify the FDC ID using usda_search_foods and try again with a valid ID.',
      );
    });

    it.each([
      ['a plain Error saying "404 Not Found"', new Error('404 Not Found')],
      [
        'a non-404 HTTP McpError saying "404" and "not found"',
        fdcHttpError(503, 'Proxy says 404: upstream route not found'),
      ],
    ])('propagates %s unchanged', async (_label, upstream) => {
      const service = await getServiceMock();
      service.getFoodDetail.mockRejectedValue(upstream);
      const ctx = createMockContext({ errors: usdaGetFood.errors });

      await expect(usdaGetFood.handler(usdaGetFood.input.parse({ fdcId: 1 }), ctx)).rejects.toBe(
        upstream,
      );
    });
  });

  describe('not_found over the real FdcService', () => {
    beforeEach(async () => {
      vi.stubEnv('USDA_FDC_API_KEY', 'test-key');
      http = createFdcFake();
      http.install();
      const actual = await vi.importActual<typeof import('@/services/fdc/fdc-service.js')>(
        '@/services/fdc/fdc-service.js',
      );
      const real = new actual.FdcService();
      const service = await getServiceMock();
      service.getFoodDetail.mockImplementation(real.getFoodDetail.bind(real));
    });

    afterEach(() => {
      http.restore();
      vi.unstubAllEnvs();
    });

    it('fails not_found with its recovery hint for an FDC 404', async () => {
      const result = await runToolContract(usdaGetFood, { fdcId: 999999999 });

      expect(http.calls.map((c) => new URL(c.request.url).pathname)).toEqual([
        '/fdc/v1/food/999999999',
      ]);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          data: {
            reason: 'not_found',
            recovery: {
              hint: 'Verify the FDC ID using usda_search_foods and try again with a valid ID.',
            },
          },
        },
      });
    });

    it('still returns a known food through the same seam', async () => {
      const result = await runToolContract(usdaGetFood, { fdcId: 168421, nutrients: [1003] });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        fdcId: 168421,
        nutrients: [{ id: 1003, amount: 2.92 }],
      });
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
    // gramWeight renders verbatim, as structuredContent carries it
    expect(text).toContain('**Basis:** 200 g (200g)');
  });

  it('escapes Markdown syntax in FDC-supplied text so content[] reads back as written', () => {
    const portion = { description: '1 bar [large] *', gramWeight: 40 };
    const output = {
      fdcId: 999,
      description: 'Crunchy *Star* Bars [Organic] | <b>new</b>',
      dataType: 'Branded',
      foodCategory: 'Snacks | Bars',
      brandOwner: '<b>Acme</b>',
      brandName: '*Star*',
      ingredients: 'OATS, HONEY [RAW] | SALT',
      servingInfo: portion,
      allPortions: [portion],
      nutrients: [
        { id: 1004, name: 'Fat *total* [lipid] | <b>', number: '204', amount: 3, unit: 'g' },
      ],
    };
    const text = firstText(format(output));
    expect(text).toContain('## Crunchy \\*Star\\* Bars \\[Organic\\] \\| \\<b>new\\</b>');
    expect(text).toContain('**Category:** Snacks \\| Bars');
    expect(text).toContain('**Brand Owner:** \\<b>Acme\\</b>');
    expect(text).toContain('**Brand:** \\*Star\\*');
    expect(text).toContain('**Ingredients:** OATS, HONEY \\[RAW\\] \\| SALT');
    expect(text).toContain('**Serving:** 1 bar \\[large\\] \\* = 40g');
    expect(text).toContain('**All portions:** 1 bar \\[large\\] \\* (40g)');
    expect(text).toContain('- **Fat \\*total\\* \\[lipid\\] \\| \\<b>** (ID: 1004, SR#: 204): 3 g');
  });
});
