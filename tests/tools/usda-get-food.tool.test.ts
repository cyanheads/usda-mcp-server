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
import type { FoodDetail } from '@/services/fdc/types.js';
import { createFdcFake } from '../fdc-fake.js';
import { allText, fdcHttpError, firstText } from '../helpers.js';

let http: FetchMockHarness;

/**
 * Routes the mocked service's `getFoodDetail` through the real `FdcService`
 * over the FDC fake for the enclosing `describe`, so a test covers FDC's
 * record shape through normalization and the tool together.
 */
function useRealFdcService(): void {
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
}

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
  basisUnit: 'g',
  foodCategory: 'Poultry Products',
  publicationDate: '2019-04-01',
  nutrients: [
    { id: 1008, name: 'Energy', number: '208', amount: 120, unit: 'KCAL' },
    { id: 1003, name: 'Protein', number: '203', amount: 22.5, unit: 'G' },
    { id: 1004, name: 'Total lipid (fat)', number: '204', amount: 2.62, unit: 'G' },
  ],
  portions: [{ description: '1 breast', gramWeight: 118 }],
} satisfies FoodDetail;

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
    useRealFdcService();

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
      basisUnit: 'g' as const,
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

  it('escapes label serving text, the label unit in the basis, and the GTIN', () => {
    const text = firstText(
      format({
        fdcId: 1,
        description: 'Drops',
        dataType: 'Branded',
        gtinUpc: '0*1',
        servingSize: 1,
        servingSizeUnit: '*IU*',
        householdServingFullText: '1 [dropper]',
        nutrients: [],
      }),
    );
    expect(text).toContain('**GTIN/UPC:** 0\\*1');
    expect(text).toContain('**Basis:** per 100 \\*IU\\* label units (basis unverified)');
    expect(text).toContain('**Label serving:** 1 \\*IU\\* (1 \\[dropper\\])');
  });

  /**
   * FDC reports a Branded food per 100 of its label unit: grams for g/GRM/GM,
   * millilitres for ml/MLT, and an unverified unit for anything else. The
   * label-unit table lives at the basis helpers' own seam; these cases prove
   * the tool's wiring, one per side of each branch.
   */
  describe('per-100 basis', () => {
    /** Kroger olive oil as the service normalizes it: a 15 ml label, per 100 ml. */
    const ML_FOOD: FoodDetail = {
      fdcId: 2151571,
      description: 'EXTRA VIRGIN OLIVE OIL, EXTRA VIRGIN',
      dataType: 'Branded',
      basisUnit: 'ml',
      servingSize: 15,
      servingSizeUnit: 'ml',
      householdServingFullText: '1 Tbsp',
      nutrients: [{ id: 1008, name: 'Energy', number: '208', amount: 800, unit: 'KCAL' }],
      portions: [],
    };
    /** A Branded label in a unit that fixes neither grams nor millilitres. */
    const LABEL_UNIT_FOOD: FoodDetail = {
      fdcId: 1,
      description: 'Label-unit food',
      dataType: 'Branded',
      servingSize: 57,
      servingSizeUnit: 'IU',
      nutrients: [{ id: 1008, name: 'Energy', number: '208', amount: 10, unit: 'KCAL' }],
      portions: [],
    };
    const ML_NOTICE =
      'FDC reports this food per 100 ml (label serving in ml); 15 g was applied as 15 ml without density conversion.';

    async function run(food: FoodDetail, input: Record<string, unknown>) {
      const service = await getServiceMock();
      service.getFoodDetail.mockResolvedValue(food);
      return runToolContract(usdaGetFood, { fdcId: food.fdcId, ...input });
    }

    it('scales an ml-basis food unconverted and says so on both surfaces', async () => {
      const result = await run(ML_FOOD, { quantity: 15, unit: 'g' });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        basisUnit: 'ml',
        scaledTo: { quantity: 15, unit: 'g', gramWeight: 15 },
        nutrients: [{ id: 1008, amount: 120 }],
        notice: ML_NOTICE,
      });
      const text = allText(result.content);
      expect(text).toContain('**Basis:** 15 g (15 ml)');
      expect(text).toContain(`> ${ML_NOTICE}`);
    });

    it('applies a mass unit to an unverified basis and names its label unit', async () => {
      const result = await run(LABEL_UNIT_FOOD, { quantity: 2, unit: 'oz' });
      const notice =
        "FDC computed this food's values per 100 label units (IU); 2 oz was applied to that basis unconverted.";

      expect(result.structuredContent).toMatchObject({
        scaledTo: { quantity: 2, unit: 'oz', gramWeight: 56.699 },
        nutrients: [{ amount: 5.6699 }],
        notice,
      });
      expect(result.structuredContent).not.toHaveProperty('basisUnit');
      const text = allText(result.content);
      expect(text).toContain('**Basis:** 2 oz (56.699 IU label units)');
      expect(text).toContain(`> ${notice}`);
    });

    it('says "no label unit" when FDC sends no label unit', async () => {
      const { servingSizeUnit: _dropped, ...food } = LABEL_UNIT_FOOD;
      const result = await run(food, { quantity: 15, unit: 'g' });

      expect(result.structuredContent).toMatchObject({
        notice:
          "FDC computed this food's values per 100 label units (no label unit); 15 g was applied to that basis unconverted.",
      });
      expect(allText(result.content)).toContain('**Basis:** 15 g (15 label units)');
    });

    it('escapes the label unit in content[] while structuredContent keeps it as sent', async () => {
      const result = await run({ ...LABEL_UNIT_FOOD, servingSizeUnit: '*IU*' }, { unit: 'g' });

      expect(result.structuredContent).toMatchObject({
        notice:
          "FDC computed this food's values per 100 label units (*IU*); 100 g was applied to that basis unconverted.",
      });
      const text = allText(result.content);
      expect(text).toContain(
        "> FDC computed this food's values per 100 label units (\\*IU\\*); 100 g was applied to that basis unconverted.",
      );
      expect(text).toContain('**Basis:** 100 g (100 \\*IU\\* label units)');
    });

    it('keeps every line of a notice inside the blockquote when the label unit holds a line break', async () => {
      const result = await run({ ...LABEL_UNIT_FOOD, servingSizeUnit: 'I\nU' }, { unit: 'g' });

      const text = allText(result.content);
      expect(text).toContain(
        "> FDC computed this food's values per 100 label units (I\\\n> U); 100 g was applied to that basis unconverted.",
      );
    });

    it.each([
      ['a per-100 g food scaled', MOCK_FOOD_DETAIL, { quantity: 15, unit: 'g' }],
      ['an ml-basis food left unscaled', ML_FOOD, {}],
      ['an unverified basis left unscaled', LABEL_UNIT_FOOD, {}],
    ])('adds no notice for %s', async (_label, food, input) => {
      const result = await run(food, input);

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).not.toHaveProperty('notice');
      expect(allText(result.content)).not.toMatch(/^>/m);
    });

    it.each([
      ['**Basis:** per 100g', MOCK_FOOD_DETAIL, 'g'],
      ['**Basis:** per 100 ml', ML_FOOD, 'ml'],
      ['**Basis:** per 100 IU label units (basis unverified)', LABEL_UNIT_FOOD, undefined],
    ])('renders %j for an unscaled food', async (line, food, basisUnit) => {
      const result = await run(food, {});

      expect((result.structuredContent as { basisUnit?: string }).basisUnit).toBe(basisUnit);
      expect(firstText(result.content).split('\n')).toContain(line);
    });

    it('returns the label serving, rendered on its own line unless it is servingInfo', async () => {
      const label = await run(ML_FOOD, {});
      expect(label.structuredContent).toMatchObject({
        servingSize: 15,
        servingSizeUnit: 'ml',
        householdServingFullText: '1 Tbsp',
      });
      expect(label.structuredContent).not.toHaveProperty('servingInfo');
      expect(firstText(label.content)).toContain('**Label serving:** 15 ml (1 Tbsp)');

      const portioned = await run(
        {
          ...ML_FOOD,
          portions: [{ description: '1 Tbsp', gramWeight: 13.5, amount: 1 }],
        },
        {},
      );
      const portionedText = firstText(portioned.content);
      expect(portionedText).toContain('**Serving:** 1 Tbsp = 13.5g (amount: 1)');
      expect(portionedText).toContain('**Label serving:** 15 ml (1 Tbsp)');

      const gramLabel = await run(
        { ...ML_FOOD, basisUnit: 'g', servingSize: 37, servingSizeUnit: 'GRM' },
        { unit: 'serving' },
      );
      expect(gramLabel.structuredContent).toMatchObject({
        servingSize: 37,
        servingSizeUnit: 'GRM',
        servingInfo: { description: 'Label serving: 37 GRM (1 Tbsp)', gramWeight: 37 },
      });
      const gramLabelText = firstText(gramLabel.content);
      expect(gramLabelText).toContain('**Serving:** Label serving: 37 GRM (1 Tbsp) = 37g');
      expect(gramLabelText).not.toContain('**Label serving:**');
    });

    it('uses an ml label only for the basis, never as a serving weight', async () => {
      const result = await run(ML_FOOD, { unit: 'serving' });

      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'no_portion_data',
            recovery: {
              hint: 'No supported serving weight is available. Label serving size: 15. Label serving unit: ml. Values are per 100 ml; a mass-unit request (g, oz, lb, kg) is applied as millilitres without density conversion.',
            },
          },
        },
      });
    });
  });

  describe('per-100 basis over the real FdcService', () => {
    useRealFdcService();

    it('scales Kroger olive oil (15 ml label) to 15 g as 15 ml, with the notice', async () => {
      const result = await runToolContract(usdaGetFood, {
        fdcId: 2151571,
        quantity: 15,
        unit: 'g',
        nutrients: [1008],
      });
      const notice =
        'FDC reports this food per 100 ml (label serving in ml); 15 g was applied as 15 ml without density conversion.';

      expect(result.structuredContent).toMatchObject({
        basisUnit: 'ml',
        scaledTo: { quantity: 15, unit: 'g', gramWeight: 15 },
        nutrients: [{ id: 1008, amount: 120 }],
        notice,
      });
      const text = allText(result.content);
      expect(text).toContain('**Basis:** 15 g (15 ml)');
      expect(text).toContain(`> ${notice}`);
    });

    it('returns milk (240 ml label) per 100 ml with its label serving and no notice', async () => {
      const result = await runToolContract(usdaGetFood, { fdcId: 2078244 });

      expect(result.structuredContent).toMatchObject({
        basisUnit: 'ml',
        servingSize: 240,
        servingSizeUnit: 'ml',
        householdServingFullText: '1 cup',
        nutrients: expect.arrayContaining([expect.objectContaining({ id: 1087, amount: 125 })]),
      });
      expect(result.structuredContent).not.toHaveProperty('notice');
      const text = allText(result.content);
      expect(text).toContain('**Basis:** per 100 ml');
      expect(text).toContain('**Label serving:** 240 ml (1 cup)');
    });

    it('keeps a per-100 g food unannotated', async () => {
      const result = await runToolContract(usdaGetFood, { fdcId: 168421, quantity: 15, unit: 'g' });

      expect(result.structuredContent).toMatchObject({ basisUnit: 'g' });
      expect(result.structuredContent).not.toHaveProperty('notice');
      expect(firstText(result.content)).toContain('**Basis:** 15 g (15g)');
    });
  });

  /** FDC's portion `amount` rides on every portion that has one, and `content[]` shows it. */
  describe('portion amounts', () => {
    it('carries the amount on servingInfo and allPortions, on both surfaces', async () => {
      const service = await getServiceMock();
      service.getFoodDetail.mockResolvedValue({
        ...MOCK_FOOD_DETAIL,
        portions: [
          { description: '2 oz', gramWeight: 57, amount: 2 },
          { description: 'Serving', gramWeight: 30 },
        ],
      });
      const result = await runToolContract(usdaGetFood, { fdcId: 171077, unit: 'serving' });

      expect(result.structuredContent).toMatchObject({
        servingInfo: { description: '2 oz', gramWeight: 57, amount: 2 },
        allPortions: [
          { description: '2 oz', gramWeight: 57, amount: 2 },
          { description: 'Serving', gramWeight: 30 },
        ],
      });
      const allPortions = (result.structuredContent as { allPortions: object[] }).allPortions;
      expect(allPortions[1]).not.toHaveProperty('amount');
      const text = firstText(result.content);
      expect(text).toContain('**Serving:** 2 oz = 57g (amount: 2)');
      expect(text).toContain('**All portions:** 2 oz (57g, amount: 2), Serving (30g)');
    });

    describe('over the real FdcService', () => {
      useRealFdcService();

      it('reads the egg custard half-cup as 0.5 cup at 141 g', async () => {
        const result = await runToolContract(usdaGetFood, { fdcId: 168787, unit: 'serving' });

        expect(result.structuredContent).toMatchObject({
          scaledTo: { quantity: 1, unit: 'serving', gramWeight: 141 },
          servingInfo: { description: '0.5 cup', gramWeight: 141, amount: 0.5 },
        });
        expect(firstText(result.content)).toContain('**Serving:** 0.5 cup = 141g (amount: 0.5)');
      });

      it("keeps FDC's portion order for the noodles and serves the 57 g entry", async () => {
        const result = await runToolContract(usdaGetFood, { fdcId: 169733, unit: 'serving' });

        expect(result.structuredContent).toMatchObject({
          scaledTo: { gramWeight: 57 },
          servingInfo: { description: '2 oz', gramWeight: 57, amount: 2 },
          allPortions: [
            { description: '2 oz', gramWeight: 57, amount: 2 },
            { description: '1 cup', gramWeight: 38, amount: 1 },
          ],
        });
        expect(firstText(result.content)).toContain(
          '**All portions:** 2 oz (57g, amount: 2), 1 cup (38g, amount: 1)',
        );
      });

      it('leaves FNDDS portions, whose description carries the amount, without one', async () => {
        const result = await runToolContract(usdaGetFood, { fdcId: 2708522, unit: 'serving' });

        expect(result.structuredContent).toMatchObject({
          scaledTo: { gramWeight: 105 },
          servingInfo: { description: '1 small/regular', gramWeight: 105 },
        });
        const { servingInfo, allPortions } = result.structuredContent as {
          servingInfo: object;
          allPortions: Array<{ description: string }>;
        };
        expect(servingInfo).not.toHaveProperty('amount');
        expect(allPortions.map((p) => p.description)).toEqual([
          '1 small/regular',
          '1 large',
          'Quantity not specified',
        ]);
        expect(allPortions.every((p) => !('amount' in p))).toBe(true);
      });
    });
  });

  describe('GTIN and category over the real FdcService', () => {
    useRealFdcService();

    it('returns a Branded GTIN as FDC stores it, on both surfaces', async () => {
      const result = await runToolContract(usdaGetFood, { fdcId: 2151571 });

      expect(result.structuredContent).toMatchObject({ gtinUpc: '011110044174' });
      expect(firstText(result.content)).toContain('**GTIN/UPC:** 011110044174');
    });

    it('omits the GTIN for a food that has none', async () => {
      const result = await runToolContract(usdaGetFood, { fdcId: 168421 });

      expect(result.structuredContent).not.toHaveProperty('gtinUpc');
      expect(firstText(result.content)).not.toContain('GTIN');
    });

    it.each([
      [2078244, 'Milk'],
      [2151571, 'Vegetable & Cooking Oils'],
      [2708522, 'Burritos and tacos'],
      [168787, 'Sweets'],
    ])('returns FDC ID %i in category %j on both surfaces', async (fdcId, category) => {
      const result = await runToolContract(usdaGetFood, { fdcId });

      expect(result.structuredContent).toMatchObject({ foodCategory: category });
      expect(firstText(result.content)).toContain(`**Category:** ${category}`);
    });
  });

  /**
   * A nutrient filter names the requested IDs the food's profile does not
   * report, so an empty or short list is never mistaken for a bad filter.
   */
  describe('missing nutrients', () => {
    it('names an unreported ID and drops the empty Nutrients heading', async () => {
      const service = await getServiceMock();
      service.getFoodDetail.mockResolvedValue({
        ...MOCK_FOOD_DETAIL,
        nutrients: [],
        missingNutrients: [1008],
      });
      const result = await runToolContract(usdaGetFood, { fdcId: 171077, nutrients: [1008] });

      expect(result.structuredContent).toMatchObject({ nutrients: [], missingNutrients: [1008] });
      const text = firstText(result.content);
      expect(text).not.toContain('### Nutrients');
      expect(text).toContain('**Missing nutrients:** 1008 (requested, not reported by this food)');
    });

    it('says an unfiltered empty profile reports nothing rather than an empty heading', async () => {
      const service = await getServiceMock();
      service.getFoodDetail.mockResolvedValue({ ...MOCK_FOOD_DETAIL, nutrients: [] });
      const result = await runToolContract(usdaGetFood, { fdcId: 171077 });

      const text = firstText(result.content);
      expect(text).not.toContain('### Nutrients');
      expect(text).toContain('**Nutrients:** none reported');
      expect(result.structuredContent).not.toHaveProperty('missingNutrients');
    });

    describe('over the real FdcService', () => {
      useRealFdcService();

      it('lists only the unreported ID beside the reported ones', async () => {
        const result = await runToolContract(usdaGetFood, {
          fdcId: 168421,
          nutrients: [1008, 99999, 2000],
        });

        expect(result.structuredContent).toMatchObject({
          nutrients: [{ id: 1008 }, { id: 2000 }],
          missingNutrients: [99999],
        });
        const text = firstText(result.content);
        expect(text).toContain('### Nutrients');
        expect(text).toContain(
          '**Missing nutrients:** 99999 (requested, not reported by this food)',
        );
      });

      it.each([
        ['no filter', {}],
        ['every requested ID present', { nutrients: [1008, 1003] }],
      ])('omits missingNutrients with %s', async (_label, filter) => {
        const result = await runToolContract(usdaGetFood, { fdcId: 168421, ...filter });

        expect(result.structuredContent).not.toHaveProperty('missingNutrients');
        expect(firstText(result.content)).not.toContain('Missing nutrients');
      });
    });
  });
});
