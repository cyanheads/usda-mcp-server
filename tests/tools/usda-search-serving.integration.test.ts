/**
 * @fileoverview Search preview, pagination, and serving contracts through real FDC normalization.
 * @module tests/tools/usda-search-serving.integration.test
 */

import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usdaGetFood } from '@/mcp-server/tools/definitions/usda-get-food.tool.js';
import { usdaSearchFoods } from '@/mcp-server/tools/definitions/usda-search-foods.tool.js';
import { getFdcService, initFdcService } from '@/services/fdc/fdc-service.js';
import type { RawFoodDetail, RawSearchResponse } from '@/services/fdc/types.js';
import { firstText } from '../helpers.js';

/** Selected fields from FDC food 2642006; nutrient values remain per 100 g. */
const CEREAL: RawFoodDetail = {
  fdcId: 2642006,
  description: 'CEREAL',
  dataType: 'Branded',
  servingSize: 37,
  servingSizeUnit: 'GRM',
  householdServingFullText: '1 cup',
  foodPortions: [],
  foodNutrients: [
    { nutrient: { id: 1003, name: 'Protein', number: '203', unitName: 'g' }, amount: 5.41 },
    { nutrient: { id: 1089, name: 'Iron, Fe', number: '303', unitName: 'mg' }, amount: 19.46 },
  ],
};

let detail: RawFoodDetail;
let search: RawSearchResponse;
let http: ReturnType<typeof createFetchMock>;

describe('search and serving over real FdcService', () => {
  beforeEach(() => {
    vi.stubEnv('USDA_FDC_API_KEY', 'test-key');
    detail = structuredClone(CEREAL);
    search = { totalHits: 1, totalPages: 1, currentPage: 1, foods: [] };
    http = createFetchMock([
      { method: 'GET', match: /\/food\/\d+$/, respond: () => Response.json(detail) },
      { method: 'POST', match: /\/foods$/, respond: () => Response.json([detail]) },
      { method: 'POST', match: /\/foods\/search$/, respond: () => Response.json(search) },
    ]);
    http.install();
    initFdcService();
  });

  afterEach(() => {
    http.restore();
    vi.unstubAllEnvs();
  });

  it('preserves full detail and batch profiles, with filters applied locally', async () => {
    const service = getFdcService();
    const ctx = createMockContext();
    expect(
      (await service.getFoodDetail(2642006, undefined, ctx)).nutrients.map((n) => n.id),
    ).toEqual([1003, 1089]);
    expect(
      (await service.getFoodsBatch([2642006], undefined, ctx)).foods[0]?.nutrients.map((n) => n.id),
    ).toEqual([1003, 1089]);
    expect((await service.getFoodDetail(2642006, [1089], ctx)).nutrients).toEqual([
      { id: 1089, name: 'Iron, Fe', number: '303', unit: 'mg', amount: 19.46 },
    ]);
    expect(http.calls.every((c) => !new URL(c.request.url).searchParams.has('nutrients'))).toBe(
      true,
    );
    expect(await http.calls[1]?.request.clone().json()).toEqual({ fdcIds: [2642006] });
  });

  it('prefers the first valid portion over a Branded label and retains actual portions', async () => {
    detail.foodPortions = [
      { gramWeight: 0 },
      { portionDescription: 'First portion', gramWeight: 21 },
      { portionDescription: 'Second portion', gramWeight: 90 },
    ];
    const result = await runToolContract(usdaGetFood, {
      fdcId: 2642006,
      quantity: 2,
      unit: 'serving',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      scaledTo: { quantity: 2, unit: 'serving', gramWeight: 42 },
      servingInfo: { description: 'First portion', gramWeight: 21 },
      allPortions: [
        { description: 'First portion', gramWeight: 21 },
        { description: 'Second portion', gramWeight: 90 },
      ],
      nutrients: [{ amount: 2.2722 }, { amount: 8.1732 }],
    });
    expect(firstText(result.content)).toContain('**Basis:** 2 serving (42g)');
  });

  it('retains genuine zero-match recovery on both surfaces', async () => {
    search = { totalHits: 0, totalPages: 0, currentPage: 1, foods: [] };
    const result = await runToolContract(usdaSearchFoods, { query: 'no-match' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'no_results',
          recovery: { hint: expect.stringContaining('check spelling') },
        },
      },
    });
    expect(firstText(result.content)).toContain('check spelling');
  });

  it('projects exactly the eight search nutrient IDs, preserving order, zeroes and distinct energies', async () => {
    const entries = [
      { nutrientId: 1089, nutrientName: 'Iron, Fe', value: 0.593, unitName: 'MG' },
      { nutrientId: 1004, nutrientName: 'Total lipid (fat)', value: 7.16, unitName: 'G' },
      { nutrientId: 1003, nutrientName: 'Protein', value: 17.9, unitName: 'G' },
      { nutrientId: 1005, nutrientName: 'Carbohydrate, by difference', value: 0, unitName: 'G' },
      {
        nutrientId: 2047,
        nutrientName: 'Energy (Atwater General Factors)',
        value: 133,
        unitName: 'KCAL',
      },
      {
        nutrientId: 2048,
        nutrientName: 'Energy (Atwater Specific Factors)',
        value: 138,
        unitName: 'KCAL',
      },
      { nutrientId: 1008, nutrientName: 'Energy', value: 120, unitName: 'KCAL' },
      { nutrientId: 1062, nutrientName: 'Energy', value: 502, unitName: 'kJ' },
      { nutrientId: 1079, nutrientName: 'Fiber, total dietary', value: 0, unitName: 'G' },
      { nutrientId: 2000, nutrientName: 'Total Sugars', value: 0.99, unitName: 'G' },
    ];
    search.foods = [
      {
        fdcId: 2514746,
        description: 'Preview fixture',
        dataType: 'Foundation',
        foodNutrients: entries,
      },
    ];
    const result = await runToolContract(usdaSearchFoods, { query: 'chicken' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      foods: [
        {
          nutrients: [
            { id: 1004, name: 'Total lipid (fat)', amount: 7.16, unit: 'G' },
            { id: 1003, name: 'Protein', amount: 17.9, unit: 'G' },
            { id: 1005, name: 'Carbohydrate, by difference', amount: 0, unit: 'G' },
            { id: 2047, name: 'Energy (Atwater General Factors)', amount: 133, unit: 'KCAL' },
            { id: 2048, name: 'Energy (Atwater Specific Factors)', amount: 138, unit: 'KCAL' },
            { id: 1008, name: 'Energy', amount: 120, unit: 'KCAL' },
            { id: 1062, name: 'Energy', amount: 502, unit: 'kJ' },
            { id: 1079, name: 'Fiber, total dietary', amount: 0, unit: 'G' },
          ],
        },
      ],
    });
    const text = firstText(result.content);
    expect(text).not.toContain('Iron');
    expect(text).not.toContain('Sugars');
    expect(text).toContain('Energy (Atwater General Factors) (ID:2047): 133KCAL');
    expect(text).toContain('Energy (Atwater Specific Factors) (ID:2048): 138KCAL');
    expect(text).toContain('Energy (ID:1062): 502kJ');
    expect(text).toContain('Fiber, total dietary (ID:1079): 0G');
  });

  it('returns empty success for an exhausted page despite upstream currentPage reset', async () => {
    search = { totalHits: 17386, totalPages: 348, currentPage: 1, foods: [] };
    const result = await runToolContract(usdaSearchFoods, {
      query: 'beef',
      dataType: ['Branded'],
      pageSize: 50,
      pageNumber: 400,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      totalHits: 17386,
      totalCount: 17386,
      currentPage: 400,
      totalPages: 348,
      foods: [],
      notice: expect.stringContaining('pageNumber: 348'),
    });
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain('page 400 of 348');
    expect(text).toContain('1–348');
    expect(text).not.toContain('spelling');
  });

  it('scales a Branded gram label and exposes its provenance on both surfaces', async () => {
    const result = await runToolContract(usdaGetFood, {
      fdcId: 2642006,
      quantity: 2,
      unit: 'serving',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      scaledTo: { quantity: 2, unit: 'serving', gramWeight: 74 },
      servingInfo: { description: 'Label serving: 37 GRM (1 cup)', gramWeight: 37 },
      nutrients: [{ amount: 4.0034 }, { amount: 14.4004 }],
    });
    expect(result.structuredContent).not.toHaveProperty('allPortions');
    expect(firstText(result.content)).toContain('**Serving:** Label serving: 37 GRM (1 cup) = 37g');
    expect(firstText(result.content)).toContain('**Basis:** 2 serving (74g)');
  });

  it('keeps metadata and a sparse empty preview across the page-size ceiling', async () => {
    search = {
      totalHits: 100,
      totalPages: 2,
      currentPage: 2,
      foods: Array.from({ length: 50 }, (_, index) => ({
        fdcId: 2642006 + index,
        description: 'CEREAL',
        dataType: 'Branded',
        servingSize: 37,
        servingSizeUnit: 'GRM',
        householdServingFullText: '1 cup',
        foodNutrients: [
          { nutrientId: 1089, nutrientName: 'Iron, Fe', value: 19.46, unitName: 'mg' },
        ],
      })),
    };
    const result = await runToolContract(usdaSearchFoods, {
      query: 'cereal',
      pageSize: 50,
      pageNumber: 2,
    });
    expect(result.structuredContent).toMatchObject({
      totalHits: 100,
      totalCount: 100,
      currentPage: 2,
      totalPages: 2,
    });
    const domain = await getFdcService().searchFoods(
      { query: 'cereal', pageSize: 50, pageNumber: 2 },
      createMockContext(),
    );
    expect(domain.foods).toHaveLength(50);
    expect(domain.foods.every((food) => food.nutrients.length === 0)).toBe(true);
    expect(domain.foods[49]).toMatchObject({
      fdcId: 2642055,
      servingSize: 37,
      servingSizeUnit: 'GRM',
      householdServingFullText: '1 cup',
    });
    expect(firstText(result.content)).toContain('**Serving:** 37GRM (1 cup)');
    expect(firstText(result.content)).not.toContain('Iron');
    expect(http.calls).toHaveLength(2);
    expect(await http.calls[0]?.request.clone().json()).toMatchObject({
      pageSize: 50,
      pageNumber: 2,
    });
  });

  it('carries label fields through detail without inventing portions or altering native values', async () => {
    const food = await getFdcService().getFoodDetail(2642006, undefined, createMockContext());
    expect(food).toMatchObject({
      servingSize: 37,
      servingSizeUnit: 'GRM',
      householdServingFullText: '1 cup',
      portions: [],
    });
    const result = await runToolContract(usdaGetFood, { fdcId: 2642006 });
    expect(result.structuredContent).toMatchObject({
      nutrients: [{ amount: 5.41 }, { amount: 19.46 }],
    });
    expect(result.structuredContent).not.toHaveProperty('scaledTo');
    expect(result.structuredContent).not.toHaveProperty('allPortions');
    expect(firstText(result.content)).toContain('**Basis:** per 100g');
  });

  it.each(['g', 'GRM', 'GM', 'gRm', 'Gm'])(
    'accepts gram label alias %s with the one-serving default',
    async (servingSizeUnit) => {
      detail.servingSizeUnit = servingSizeUnit;
      const result = await runToolContract(usdaGetFood, { fdcId: 2642006, unit: 'serving' });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        scaledTo: { quantity: 1, unit: 'serving', gramWeight: 37 },
        nutrients: [{ amount: 2.0017 }, { amount: 7.2002 }],
      });
      expect(firstText(result.content)).toContain(
        `Label serving: 37 ${servingSizeUnit} (1 cup) = 37g`,
      );
    },
  );

  it('supports a fractional label serving and existing four-decimal rounding', async () => {
    const result = await runToolContract(usdaGetFood, {
      fdcId: 2642006,
      unit: 'serving',
      quantity: 0.33333,
    });
    expect(result.structuredContent).toMatchObject({
      scaledTo: { quantity: 0.33333, unit: 'serving', gramWeight: 12.3332 },
      nutrients: [{ amount: 0.6672 }, { amount: 2.4 }],
    });
    expect(firstText(result.content)).toContain('**Basis:** 0.33333 serving (12.3332g)');
  });

  it.each([
    { servingSize: 0, servingSizeUnit: 'g' },
    { servingSize: -1, servingSizeUnit: 'g' },
    { servingSize: undefined, servingSizeUnit: 'g' },
    { servingSize: Number.NaN, servingSizeUnit: 'g' },
    { servingSize: Number.POSITIVE_INFINITY, servingSizeUnit: 'g' },
    { servingSize: 37, servingSizeUnit: undefined },
    { servingSize: 240, servingSizeUnit: 'ml' },
    { servingSize: 240, servingSizeUnit: 'MLT' },
    { servingSize: 37, servingSizeUnit: 'IU' },
    { servingSize: 37, servingSizeUnit: 'MG' },
    { servingSize: 37, servingSizeUnit: 'oz' },
  ])(
    'rejects unsupported label $servingSize $servingSizeUnit with actionable recovery',
    async (label) => {
      Object.assign(detail, label);
      const result = await runToolContract(usdaGetFood, { fdcId: 2642006, unit: 'serving' });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'no_portion_data',
            recovery: { hint: expect.stringContaining('explicit mass-unit request') },
          },
        },
      });
      const text = firstText(result.content);
      expect(text).toContain('explicit mass-unit request');
      if (label.servingSizeUnit)
        expect(text).toContain(`Label serving unit: ${label.servingSizeUnit}.`);
      if (label.servingSize != null && Number.isFinite(label.servingSize))
        expect(text).toContain(`Label serving size: ${label.servingSize}.`);
    },
  );

  it('does not treat another data type label as a Branded serving', async () => {
    detail.dataType = 'Foundation';
    const result = await runToolContract(usdaGetFood, { fdcId: 2642006, unit: 'serving' });
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'no_portion_data' } },
    });
  });

  it('rejects a non-finite label size parsed from a valid JSON numeric exponent', async () => {
    http.restore();
    http = createFetchMock([
      {
        method: 'GET',
        match: /\/food\/\d+$/,
        respond: () =>
          new Response(
            '{"fdcId":2642006,"description":"CEREAL","dataType":"Branded","foodPortions":[],"servingSize":1e400,"servingSizeUnit":"GRM"}',
          ),
      },
    ]);
    http.install();
    const result = await runToolContract(usdaGetFood, { fdcId: 2642006, unit: 'serving' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'no_portion_data' } },
    });
    expect(firstText(result.content)).toContain('explicit mass-unit request');
  });

  it('retains mass defaults and quantity-without-unit recovery on label records', async () => {
    const mass = await runToolContract(usdaGetFood, { fdcId: 2642006, unit: 'g' });
    expect(mass.structuredContent).toMatchObject({
      scaledTo: { quantity: 100, unit: 'g', gramWeight: 100 },
      nutrients: [{ amount: 5.41 }, { amount: 19.46 }],
    });
    const invalid = await runToolContract(usdaGetFood, { fdcId: 2642006, quantity: 2 });
    expect(invalid.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'quantity_without_unit',
          recovery: { hint: 'Provide unit (g, oz, lb, kg, or serving) alongside quantity.' },
        },
      },
    });
    expect(firstText(invalid.content)).toContain(
      'Provide unit (g, oz, lb, kg, or serving) alongside quantity.',
    );
  });
});
