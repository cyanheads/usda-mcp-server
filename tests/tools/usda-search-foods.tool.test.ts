/**
 * @fileoverview Tests for usda_search_foods tool.
 * @module tests/tools/usda-search-foods.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usdaSearchFoods } from '@/mcp-server/tools/definitions/usda-search-foods.tool.js';
import { allText, firstText } from '../helpers.js';

const { format } = usdaSearchFoods;
if (!format) throw new Error('usda_search_foods must declare format()');

/**
 * Mock the FDC service so tests don't hit the network. The module's constants
 * (`FDC_RESULT_WINDOW`) stay real, so the handler branches on the same window
 * the service exports.
 */
vi.mock('@/services/fdc/fdc-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/fdc/fdc-service.js')>();
  const mockService = {
    searchFoods: vi.fn(),
  };
  return {
    ...actual,
    FdcService: vi.fn(() => mockService),
    getFdcService: vi.fn(() => mockService),
    initFdcService: vi.fn(),
  };
});

/** The description `tools/list` advertises for one input property. */
function inputDescription(key: string): string {
  const schema = z.toJSONSchema(usdaSearchFoods.input) as {
    properties: Record<string, { description?: string }>;
  };
  return schema.properties[key]?.description ?? '';
}

async function getServiceMock() {
  const { getFdcService } = await import('@/services/fdc/fdc-service.js');
  return getFdcService() as unknown as { searchFoods: ReturnType<typeof vi.fn> };
}

const MOCK_FOOD = {
  fdcId: 171077,
  description: 'Chicken, broilers or fryers, breast, meat only, raw',
  dataType: 'SR Legacy',
  basisUnit: 'g',
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
    service.searchFoods.mockClear();
    service.searchFoods.mockResolvedValue(MOCK_SEARCH_RESULT);
  });

  it('returns matching foods for a valid query', async () => {
    const ctx = createMockContext({ errors: usdaSearchFoods.errors });
    const input = usdaSearchFoods.input.parse({ query: 'chicken breast' });
    const result = await usdaSearchFoods.handler(input, ctx);

    expect(result.totalHits).toBe(1);
    expect(result.currentPage).toBe(1);
    expect(result.foods).toHaveLength(1);
    expect(result.foods[0]?.fdcId).toBe(171077);
    expect(result.foods[0]?.description).toContain('Chicken');
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

  it('defaults to Branded when brandOwner is set and dataType is omitted', async () => {
    const service = await getServiceMock();
    const ctx = createMockContext({ errors: usdaSearchFoods.errors });
    const input = usdaSearchFoods.input.parse({ query: 'oats', brandOwner: 'Quaker' });
    await usdaSearchFoods.handler(input, ctx);

    expect(service.searchFoods).toHaveBeenCalledWith(
      expect.objectContaining({ dataType: ['Branded'], brandOwner: 'Quaker' }),
      ctx,
    );
  });

  it('leaves an explicit non-Branded dataType alone when brandOwner is set', async () => {
    const service = await getServiceMock();
    const ctx = createMockContext({ errors: usdaSearchFoods.errors });
    const input = usdaSearchFoods.input.parse({
      query: 'oats',
      brandOwner: 'Quaker',
      dataType: ['SR Legacy'],
    });
    await usdaSearchFoods.handler(input, ctx);

    expect(service.searchFoods).toHaveBeenCalledWith(
      expect.objectContaining({ dataType: ['SR Legacy'], brandOwner: 'Quaker' }),
      ctx,
    );
  });

  it('keeps the SR Legacy default when brandOwner is whitespace-only', async () => {
    const service = await getServiceMock();
    const ctx = createMockContext({ errors: usdaSearchFoods.errors });
    const input = usdaSearchFoods.input.parse({ query: 'oats', brandOwner: '   ' });
    await usdaSearchFoods.handler(input, ctx);

    expect(service.searchFoods).toHaveBeenCalledWith(
      expect.objectContaining({ dataType: ['SR Legacy'] }),
      ctx,
    );
    expect(service.searchFoods.mock.calls[0]?.[0]).not.toHaveProperty('brandOwner');
  });

  it('names the searched data sources when a brandOwner search finds nothing', async () => {
    const service = await getServiceMock();
    service.searchFoods.mockResolvedValue({
      totalHits: 0,
      currentPage: 1,
      totalPages: 0,
      foods: [],
    });
    const ctx = createMockContext({ errors: usdaSearchFoods.errors });
    const input = usdaSearchFoods.input.parse({ query: 'oats', brandOwner: 'Quaker' });

    await expect(usdaSearchFoods.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_results', dataType: ['Branded'] },
      message: expect.stringContaining('Branded'),
    });
  });

  it('throws ctx.fail("query_empty") for whitespace-only query', async () => {
    const ctx = createMockContext({ errors: usdaSearchFoods.errors });
    const input = usdaSearchFoods.input.parse({ query: '   ' });
    await expect(usdaSearchFoods.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'query_empty' },
    });
  });

  it('schema rejects empty string query', () => {
    expect(() => usdaSearchFoods.input.parse({ query: '' })).toThrow();
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

  describe('pagination boundaries', () => {
    it('applies the documented pageSize and pageNumber defaults', () => {
      const input = usdaSearchFoods.input.parse({ query: 'kale' });

      expect(input.pageSize).toBe(10);
      expect(input.pageNumber).toBe(1);
    });

    it('accepts the declared pageSize edges and rejects one past the cap', () => {
      expect(usdaSearchFoods.input.parse({ query: 'kale', pageSize: 1 }).pageSize).toBe(1);
      expect(usdaSearchFoods.input.parse({ query: 'kale', pageSize: 50 }).pageSize).toBe(50);
      expect(() => usdaSearchFoods.input.parse({ query: 'kale', pageSize: 51 })).toThrow();
    });

    it('rejects a page number below the 1-based floor', () => {
      expect(() => usdaSearchFoods.input.parse({ query: 'kale', pageNumber: 0 })).toThrow();
      expect(() => usdaSearchFoods.input.parse({ query: 'kale', pageNumber: -1 })).toThrow();
    });

    it('forwards pageSize and pageNumber to the service unchanged', async () => {
      const service = await getServiceMock();
      const ctx = createMockContext({ errors: usdaSearchFoods.errors });
      const input = usdaSearchFoods.input.parse({ query: 'kale', pageSize: 50, pageNumber: 3 });
      await usdaSearchFoods.handler(input, ctx);

      expect(service.searchFoods).toHaveBeenCalledWith(
        expect.objectContaining({ pageSize: 50, pageNumber: 3 }),
        ctx,
      );
    });

    it('returns empty success and a notice for a page past the end', async () => {
      const service = await getServiceMock();
      // FDC answers a past-the-end page with 200 and an empty foods[], keeping
      // the real totalHits but resetting currentPage to 1.
      service.searchFoods.mockResolvedValue({
        totalHits: 12,
        currentPage: 1,
        totalPages: 2,
        foods: [],
      });
      const ctx = createMockContext({ errors: usdaSearchFoods.errors });
      const input = usdaSearchFoods.input.parse({ query: 'kale', pageNumber: 99 });

      const result = await usdaSearchFoods.handler(input, ctx);
      expect(result).toEqual({ totalHits: 12, currentPage: 99, totalPages: 2, foods: [] });
      expect(getEnrichment(ctx)).toMatchObject({
        totalCount: 12,
        notice: expect.stringContaining('pageNumber: 2'),
      });
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
          basisUnit: 'g' as const,
          nutrients: [{ id: 1008, name: 'Energy', amount: 120, unit: 'KCAL' }],
        },
      ],
    };
    const text = firstText(format(output));
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
          basisUnit: 'g' as const,
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
    const text = firstText(format(output));
    expect(text).toContain('General Mills');
    expect(text).toContain('Nature Valley');
    expect(text).toContain('42');
    expect(text).toContain('2022-01-01');
  });

  describe('serving line', () => {
    const servingLine = (food: Record<string, unknown>) => {
      const text = firstText(
        format({
          totalHits: 1,
          currentPage: 1,
          totalPages: 1,
          foods: [
            { fdcId: 2078244, description: 'MILK', dataType: 'Branded', nutrients: [], ...food },
          ],
        }),
      );
      return text.split('\n').find((line) => line.startsWith('**Serving:**'));
    };

    it('renders the unit FDC sent, volume included', () => {
      expect(servingLine({ servingSize: 240, servingSizeUnit: 'ml' })).toBe('**Serving:** 240ml');
    });

    it('renders the size alone when FDC sends no unit', () => {
      expect(servingLine({ servingSize: 240 })).toBe('**Serving:** 240');
    });

    it('still renders grams with the household serving in parentheses', () => {
      expect(
        servingLine({ servingSize: 42, servingSizeUnit: 'g', householdServingFullText: '2 bars' }),
      ).toBe('**Serving:** 42g (2 bars)');
    });

    it('omits the line when FDC sends no serving size', () => {
      expect(servingLine({ servingSizeUnit: 'g' })).toBeUndefined();
    });
  });

  it('escapes Markdown syntax in FDC-supplied text so content[] reads back as written', () => {
    const output = {
      totalHits: 1,
      currentPage: 1,
      totalPages: 1,
      foods: [
        {
          fdcId: 999,
          description: 'Crunchy *Star* Bars [Organic]',
          dataType: 'Branded',
          basisUnit: 'g' as const,
          foodCategory: 'Snacks | Bars',
          brandOwner: '<b>Acme</b>',
          brandName: '*Star*',
          servingSize: 40,
          servingSizeUnit: 'g',
          householdServingFullText: '1 bar [large] *',
          nutrients: [{ id: 1004, name: 'Fat *total* [lipid]', amount: 3, unit: 'G' }],
        },
      ],
    };
    const text = firstText(format(output));
    expect(text).toContain('### Crunchy \\*Star\\* Bars \\[Organic\\]');
    expect(text).toContain('**Category:** Snacks \\| Bars');
    expect(text).toContain('**Brand Owner:** \\<b>Acme\\</b>');
    expect(text).toContain('**Brand:** \\*Star\\*');
    expect(text).toContain('**Serving:** 40g (1 bar \\[large\\] \\*)');
    expect(text).toContain('**Nutrients (per 100g):** Fat \\*total\\* \\[lipid\\] (ID:1004): 3G');
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
    expect(result.foods).toHaveLength(1);
    expect(result.foods[0]?.foodCategory).toBeUndefined();
    expect(result.foods[0]?.brandOwner).toBeUndefined();
  });

  it('adds no notice to an in-window page of at most 100,000 matches', async () => {
    const ctx = createMockContext({ errors: usdaSearchFoods.errors });
    await usdaSearchFoods.handler(usdaSearchFoods.input.parse({ query: 'chicken breast' }), ctx);

    expect(getEnrichment(ctx)).toEqual({ totalCount: 1 });
  });

  describe('per-100 basis', () => {
    it('keeps basisUnit on rows and labels each row by its basis on both surfaces', async () => {
      const service = await getServiceMock();
      service.searchFoods.mockResolvedValue({
        totalHits: 3,
        currentPage: 1,
        totalPages: 1,
        foods: [
          {
            fdcId: 2078244,
            description: 'MILK',
            dataType: 'Branded',
            basisUnit: 'ml',
            servingSize: 240,
            servingSizeUnit: 'ml',
            nutrients: [{ id: 1003, name: 'Protein', amount: 3.33, unit: 'G' }],
          },
          {
            fdcId: 2642006,
            description: 'CEREAL',
            dataType: 'Branded',
            basisUnit: 'g',
            nutrients: [],
          },
          {
            fdcId: 2538887,
            description: 'GUMMIES',
            dataType: 'Branded',
            servingSize: 57,
            servingSizeUnit: '[IU]',
            nutrients: [{ id: 1008, name: 'Energy', amount: 351, unit: 'KCAL' }],
          },
        ],
      });

      const result = await runToolContract(usdaSearchFoods, {
        query: 'milk',
        dataType: ['Branded'],
      });

      expect(result.isError).toBeFalsy();
      const foods = (result.structuredContent as { foods: Record<string, unknown>[] }).foods;
      expect(foods.map((food) => food.basisUnit)).toEqual(['ml', 'g', undefined]);
      expect(foods[2]).not.toHaveProperty('basisUnit');
      const text = firstText(result.content);
      expect(text).toContain('**Nutrients (per 100 ml):** Protein (ID:1003): 3.33G');
      expect(text).toContain('**Basis:** per 100g');
      expect(text).toContain(
        '**Nutrients (per 100 \\[IU\\] label units (basis unverified)):** Energy (ID:1008): 351KCAL',
      );
    });

    it('describes preview amounts by basisUnit rather than as per 100g', () => {
      const schema = z.toJSONSchema(usdaSearchFoods.output) as Record<string, unknown>;
      const text = JSON.stringify(schema);

      expect(text).not.toContain('per 100g');
      expect(text).toContain('basisUnit');
    });
  });

  describe('brandOwner and foodCategory filters', () => {
    it('forwards trimmed filter values for the service to encode', async () => {
      const service = await getServiceMock();
      const ctx = createMockContext({ errors: usdaSearchFoods.errors });
      const input = usdaSearchFoods.input.parse({
        query: 'chicken',
        brandOwner: '  Kellogg Company ',
        foodCategory: ' Poultry Products  ',
      });
      await usdaSearchFoods.handler(input, ctx);

      expect(service.searchFoods).toHaveBeenCalledWith(
        expect.objectContaining({
          brandOwner: 'Kellogg Company',
          foodCategory: 'Poultry Products',
        }),
        ctx,
      );
    });

    it.each(['brandOwner', 'foodCategory'])(
      'describes %s as a case-insensitive phrase match with wildcard and query escapes',
      (key) => {
        const description = inputDescription(key);

        expect(description).toContain('phrase');
        expect(description).toContain('ignoring case');
        expect(description).toContain('*');
        expect(description).toContain('query');
        expect(description).not.toContain('Case-sensitive');
      },
    );

    it('describes foodCategory wildcards on every data type, and a whole word plus * as matching nothing', () => {
      const description = inputDescription('foodCategory');

      expect(description).toContain(
        'A value containing * or ? is sent as wildcard terms instead, each word matched on its own (e.g. "Poult*"); a whole word followed by * can match nothing ("Poultry*" does), so shorten it.',
      );
      expect(description).not.toContain('Branded categories only');
    });
  });

  describe('no_results after brandOwner or foodCategory', () => {
    it.each([
      [
        'brandOwner',
        { query: 'oats', brandOwner: '  Quaker  ' },
        'No foods matched "oats" in Branded with brandOwner "Quaker".',
        'No foods matched "oats" in Branded with brandOwner "Quaker". A filter without * or ? must match as one phrase: check it against the brandOwner values an unfiltered search returns, or drop it. Try a simpler query or check spelling.',
      ],
      [
        'foodCategory',
        { query: 'chicken', foodCategory: ' Poultry ' },
        'No foods matched "chicken" in SR Legacy with foodCategory "Poultry".',
        'No foods matched "chicken" in SR Legacy with foodCategory "Poultry". A filter without * or ? must match as one phrase: check it against the foodCategory values an unfiltered search returns, or drop it. Try a simpler query, check spelling, or add "Branded" to dataType.',
      ],
      [
        'brandOwner and foodCategory',
        { query: 'cereal', brandOwner: 'Kellogg', foodCategory: 'Cereal' },
        'No foods matched "cereal" in Branded with brandOwner "Kellogg" and foodCategory "Cereal".',
        'No foods matched "cereal" in Branded with brandOwner "Kellogg" and foodCategory "Cereal". A filter without * or ? must match as one phrase: check it against the brandOwner or foodCategory values an unfiltered search returns, or drop it. Try a simpler query or check spelling.',
      ],
      [
        'requireAllWords and foodCategory',
        { query: 'rice brown', requireAllWords: true, foodCategory: 'Cereal Grains and Pasta' },
        'No foods matched "rice brown" in SR Legacy with foodCategory "Cereal Grains and Pasta".',
        'Retry without requireAllWords so a food matching any one query word counts. A filter without * or ? must match as one phrase: check it against the foodCategory values an unfiltered search returns, or drop it. Try a simpler query, check spelling, or add "Branded" to dataType.',
      ],
      [
        'a wildcard foodCategory',
        { query: 'chicken', foodCategory: 'Poultry*' },
        'No foods matched "chicken" in SR Legacy with foodCategory "Poultry*".',
        'No foods matched "chicken" in SR Legacy with foodCategory "Poultry*". A wildcard can match nothing where a shorter one matches ("Poultry*" vs "Poult*"): shorten it, or drop the foodCategory filter. Try a simpler query, check spelling, or add "Branded" to dataType.',
      ],
      [
        'a phrase brandOwner and a wildcard foodCategory',
        { query: 'cereal', brandOwner: 'Kellogg', foodCategory: 'Cer?al' },
        'No foods matched "cereal" in Branded with brandOwner "Kellogg" and foodCategory "Cer?al".',
        'No foods matched "cereal" in Branded with brandOwner "Kellogg" and foodCategory "Cer?al". A filter without * or ? must match as one phrase: check it against the brandOwner values an unfiltered search returns, or drop it. A wildcard can match nothing where a shorter one matches ("Poultry*" vs "Poult*"): shorten it, or drop the foodCategory filter. Try a simpler query or check spelling.',
      ],
      [
        'no filter',
        { query: 'zzqx' },
        'No foods matched "zzqx" in SR Legacy.',
        'No foods matched "zzqx" in SR Legacy. Try a simpler query, check spelling, or add "Branded" to dataType.',
      ],
      [
        'whitespace-only filters, which are not sent',
        { query: 'zzqx', brandOwner: '  ', foodCategory: ' ' },
        'No foods matched "zzqx" in SR Legacy.',
        'No foods matched "zzqx" in SR Legacy. Try a simpler query, check spelling, or add "Branded" to dataType.',
      ],
      [
        'requireAllWords and no filter',
        { query: 'rice brown', requireAllWords: true },
        'No foods matched "rice brown" in SR Legacy.',
        'Retry without requireAllWords so a food matching any one query word counts. Try a simpler query, check spelling, or add "Branded" to dataType.',
      ],
    ])('with %s: message and hint on both surfaces', async (_label, args, message, hint) => {
      const service = await getServiceMock();
      service.searchFoods.mockResolvedValue({
        totalHits: 0,
        currentPage: 1,
        totalPages: 0,
        foods: [],
      });

      const result = await runToolContract(usdaSearchFoods, args);

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { message, data: { reason: 'no_results', recovery: { hint } } },
      });
      const text = allText(result.content);
      expect(text).toContain(`Error: ${escapeMarkdownInline(message)}`);
      expect(text).toContain(`Recovery: ${escapeMarkdownInline(hint)}`);
    });
  });

  describe('FDC result window', () => {
    const SALT_ROW = {
      fdcId: 2000001,
      description: 'SALT',
      dataType: 'Branded',
      basisUnit: 'g',
      nutrients: [],
    };
    const RICE_ROW = {
      fdcId: 169704,
      description: 'Rice, brown, long-grain, cooked',
      dataType: 'SR Legacy',
      basisUnit: 'g',
      nutrients: [],
    };

    it.each([
      [50, 2000],
      [1, 100_000],
    ])(
      'sends %i × %i, the last page inside the window, unchanged',
      async (pageSize, pageNumber) => {
        const service = await getServiceMock();
        service.searchFoods.mockResolvedValue({
          totalHits: 283_963,
          currentPage: pageNumber,
          totalPages: pageSize === 1 ? 283_963 : 5680,
          foods: [SALT_ROW],
        });

        const result = await runToolContract(usdaSearchFoods, {
          query: 'salt',
          dataType: ['Branded'],
          pageSize,
          pageNumber,
        });

        expect(service.searchFoods).toHaveBeenCalledWith(
          expect.objectContaining({ pageSize, pageNumber }),
          expect.anything(),
        );
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          currentPage: pageNumber,
          foods: [{ fdcId: 2000001 }],
        });
      },
    );

    it('requests page 1 past the window and answers a page past the end with the last page', async () => {
      const service = await getServiceMock();
      // Page 1 at the same pageSize carries the totals; its rows are not the page asked for.
      service.searchFoods.mockResolvedValue({
        totalHits: 132,
        currentPage: 1,
        totalPages: 3,
        foods: [RICE_ROW],
      });

      const result = await runToolContract(usdaSearchFoods, {
        query: 'rice',
        pageSize: 50,
        pageNumber: 9999,
      });

      expect(service.searchFoods).toHaveBeenCalledTimes(1);
      expect(service.searchFoods).toHaveBeenCalledWith(
        expect.objectContaining({ pageSize: 50, pageNumber: 1 }),
        expect.anything(),
      );
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        totalHits: 132,
        totalCount: 132,
        currentPage: 9999,
        totalPages: 3,
        foods: [],
        notice: expect.stringContaining('retry with pageNumber: 3.'),
      });
      expect((result.structuredContent as { notice: string }).notice).not.toContain('100,000');
      expect(allText(result.content)).toContain('retry with pageNumber: 3.');
    });

    it('fails result_window_exceeded naming the last reachable page on both surfaces', async () => {
      const service = await getServiceMock();
      service.searchFoods.mockResolvedValue({
        totalHits: 283_963,
        currentPage: 1,
        totalPages: 283_963,
        foods: [SALT_ROW],
      });

      const result = await runToolContract(usdaSearchFoods, {
        query: 'salt',
        dataType: ['Branded'],
        pageSize: 1,
        pageNumber: 100_001,
      });

      expect(service.searchFoods).toHaveBeenCalledWith(
        expect.objectContaining({ pageSize: 1, pageNumber: 1 }),
        expect.anything(),
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'result_window_exceeded',
            pageSize: 1,
            pageNumber: 100_001,
            totalHits: 283_963,
            lastReachablePage: 100_000,
            recovery: { hint: expect.stringContaining('pageNumber: 100000') },
          },
        },
      });
      const text = allText(result.content);
      expect(text).toContain('pageNumber: 100000');
      expect(text).toContain('result_window_exceeded');
    });

    it('caps a page past the end at the window and composes one notice', async () => {
      const service = await getServiceMock();
      service.searchFoods.mockResolvedValue({
        totalHits: 283_963,
        currentPage: 1,
        totalPages: 5680,
        foods: [SALT_ROW],
      });

      const result = await runToolContract(usdaSearchFoods, {
        query: 'salt',
        dataType: ['Branded'],
        pageSize: 50,
        pageNumber: 9999,
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        totalHits: 283_963,
        currentPage: 9999,
        totalPages: 5680,
        foods: [],
      });
      const { notice } = result.structuredContent as { notice: string };
      expect(notice).toContain('Valid pages are 1–2000; retry with pageNumber: 2000.');
      expect(notice).toContain('100,000 of the 283,963');
      const text = allText(result.content);
      expect(text).toContain('retry with pageNumber: 2000.');
      expect(text).toContain('100,000 of the 283,963');
    });

    it('notes the window on an in-window page when more than 100,000 foods match', async () => {
      const service = await getServiceMock();
      service.searchFoods.mockResolvedValue({
        totalHits: 283_963,
        currentPage: 1,
        totalPages: 5680,
        foods: [SALT_ROW],
      });

      const result = await runToolContract(usdaSearchFoods, {
        query: 'salt',
        dataType: ['Branded'],
        pageSize: 50,
      });

      expect(result.structuredContent).toMatchObject({
        foods: [{ fdcId: 2000001 }],
        notice: expect.stringContaining('no page past 2000 at pageSize 50'),
      });
      expect(allText(result.content)).toContain('no page past 2000 at pageSize 50');
    });

    it.each([
      [100_000, 2000, false],
      [100_001, 2001, true],
    ])('notes the window at %i matches (%i pages): %s', async (totalHits, totalPages, noted) => {
      const service = await getServiceMock();
      service.searchFoods.mockResolvedValue({
        totalHits,
        currentPage: 1,
        totalPages,
        foods: [SALT_ROW],
      });
      const ctx = createMockContext({ errors: usdaSearchFoods.errors });
      await usdaSearchFoods.handler(
        usdaSearchFoods.input.parse({ query: 'salt', pageSize: 50 }),
        ctx,
      );

      expect('notice' in getEnrichment(ctx)).toBe(noted);
    });

    it('keeps a query with no matches past the window as no_results', async () => {
      const service = await getServiceMock();
      service.searchFoods.mockResolvedValue({
        totalHits: 0,
        currentPage: 1,
        totalPages: 0,
        foods: [],
      });
      const ctx = createMockContext({ errors: usdaSearchFoods.errors });
      const input = usdaSearchFoods.input.parse({ query: 'zzqx', pageSize: 50, pageNumber: 2001 });

      await expect(usdaSearchFoods.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'no_results' },
      });
      expect(service.searchFoods).toHaveBeenCalledWith(
        expect.objectContaining({ pageSize: 50, pageNumber: 1 }),
        ctx,
      );
    });

    it('describes the window on pageNumber and totalPages', () => {
      expect(inputDescription('pageNumber')).toContain('100,000');
      const output = JSON.stringify(z.toJSONSchema(usdaSearchFoods.output));
      expect(output).toMatch(/"totalPages":\{[^}]*100,000/);
    });
  });

  describe('requireAllWords', () => {
    it('defaults to false and rejects a non-boolean', () => {
      expect(usdaSearchFoods.input.parse({ query: 'rice' }).requireAllWords).toBe(false);
      expect(() =>
        usdaSearchFoods.input.parse({ query: 'rice', requireAllWords: 'yes' }),
      ).toThrow();
    });

    it('forwards requireAllWords: true to the service', async () => {
      const service = await getServiceMock();
      const ctx = createMockContext({ errors: usdaSearchFoods.errors });
      const input = usdaSearchFoods.input.parse({
        query: 'rice brown cooked',
        requireAllWords: true,
      });
      await usdaSearchFoods.handler(input, ctx);

      expect(service.searchFoods).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'rice brown cooked', requireAllWords: true }),
        ctx,
      );
    });

    it.each([{}, { requireAllWords: false }])(
      'leaves requireAllWords off the service call for %o',
      async (extra) => {
        const service = await getServiceMock();
        const ctx = createMockContext({ errors: usdaSearchFoods.errors });
        await usdaSearchFoods.handler(
          usdaSearchFoods.input.parse({ query: 'rice brown cooked', ...extra }),
          ctx,
        );

        expect(service.searchFoods.mock.calls[0]?.[0]).not.toHaveProperty('requireAllWords');
      },
    );

    it('opens the no_results recovery with "Retry without requireAllWords" under it', async () => {
      const service = await getServiceMock();
      service.searchFoods.mockResolvedValue({
        totalHits: 0,
        currentPage: 1,
        totalPages: 0,
        foods: [],
      });

      const result = await runToolContract(usdaSearchFoods, {
        query: 'rice brown cooked basmati',
        requireAllWords: true,
      });

      expect(result.isError).toBe(true);
      const { hint } = (
        result.structuredContent as { error: { data: { recovery: { hint: string } } } }
      ).error.data.recovery;
      expect(hint.startsWith('Retry without requireAllWords')).toBe(true);
      expect(allText(result.content)).toContain(`Recovery: ${hint}`);
    });

    it('keeps the default no_results recovery free of requireAllWords', async () => {
      const service = await getServiceMock();
      service.searchFoods.mockResolvedValue({
        totalHits: 0,
        currentPage: 1,
        totalPages: 0,
        foods: [],
      });

      const result = await runToolContract(usdaSearchFoods, { query: 'zzqx' });

      const { hint } = (
        result.structuredContent as { error: { data: { recovery: { hint: string } } } }
      ).error.data.recovery;
      expect(hint).toBe(
        'No foods matched "zzqx" in SR Legacy. Try a simpler query, check spelling, or add "Branded" to dataType.',
      );
    });

    it('states the any-word default in the query description', () => {
      const description = inputDescription('query');

      expect(description).toContain('any one');
      expect(description).toContain('requireAllWords');
      expect(description).toContain('+');
    });
  });

  describe('bare digit queries', () => {
    it.each(['11111000', '02114029705', '00012345678905', ' 02114029705 '])(
      'defaults %j to Branded and Survey (FNDDS)',
      async (query) => {
        const service = await getServiceMock();
        const ctx = createMockContext({ errors: usdaSearchFoods.errors });
        await usdaSearchFoods.handler(usdaSearchFoods.input.parse({ query }), ctx);

        expect(service.searchFoods).toHaveBeenCalledWith(
          expect.objectContaining({ query: query.trim(), dataType: ['Branded', 'Survey (FNDDS)'] }),
          ctx,
        );
      },
    );

    it.each(['1234567', '123456789012345', '02114029705 milk', '0211 4029705', '0211402970a'])(
      'keeps the SR Legacy default for %j',
      async (query) => {
        const service = await getServiceMock();
        const ctx = createMockContext({ errors: usdaSearchFoods.errors });
        await usdaSearchFoods.handler(usdaSearchFoods.input.parse({ query }), ctx);

        expect(service.searchFoods).toHaveBeenCalledWith(
          expect.objectContaining({ dataType: ['SR Legacy'] }),
          ctx,
        );
      },
    );

    it.each([
      [{ dataType: ['SR Legacy'] }, ['SR Legacy']],
      [{ brandOwner: 'Kroger' }, ['Branded']],
    ])('lets %o decide the data sources of a bare code', async (extra, expected) => {
      const service = await getServiceMock();
      const ctx = createMockContext({ errors: usdaSearchFoods.errors });
      await usdaSearchFoods.handler(
        usdaSearchFoods.input.parse({ query: '02114029705', ...extra }),
        ctx,
      );

      expect(service.searchFoods).toHaveBeenCalledWith(
        expect.objectContaining({ dataType: expected }),
        ctx,
      );
    });

    it('returns gtinUpc on Branded rows on both surfaces, leading zeros intact', async () => {
      const service = await getServiceMock();
      service.searchFoods.mockResolvedValue({
        totalHits: 2,
        currentPage: 1,
        totalPages: 1,
        foods: [
          {
            fdcId: 2078244,
            description: 'MILK',
            dataType: 'Branded',
            basisUnit: 'ml',
            gtinUpc: '02114029705',
            nutrients: [],
          },
          { ...MOCK_FOOD },
        ],
      });

      const result = await runToolContract(usdaSearchFoods, { query: '02114029705' });

      const foods = (result.structuredContent as { foods: Record<string, unknown>[] }).foods;
      expect(foods[0]?.gtinUpc).toBe('02114029705');
      expect(foods[1]).not.toHaveProperty('gtinUpc');
      const text = firstText(result.content);
      expect(text).toContain('**GTIN/UPC:** 02114029705');
      expect(text.match(/GTIN\/UPC/g)).toHaveLength(1);
    });

    it('describes the bare-code default on dataType', () => {
      expect(inputDescription('dataType')).toContain('["Branded", "Survey (FNDDS)"]');
      expect(usdaSearchFoods.description).toContain('8–14 digits');
    });
  });
});
