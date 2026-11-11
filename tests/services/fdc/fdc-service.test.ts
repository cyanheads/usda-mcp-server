/**
 * @fileoverview Tests for FdcService against a stand-in FoodData Central API.
 * The tool and resource suites mock this service wholesale, so its real
 * normalization and nutrient-filter path is only exercised here.
 * @module tests/services/fdc/fdc-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usdaCompareFoods } from '@/mcp-server/tools/definitions/usda-compare-foods.tool.js';
import { usdaGetFood } from '@/mcp-server/tools/definitions/usda-get-food.tool.js';
import { usdaSearchFoods } from '@/mcp-server/tools/definitions/usda-search-foods.tool.js';
import {
  encodeFdcFilter,
  escapeFdcQuery,
  FDC_RESULT_WINDOW,
  FdcService,
  initFdcService,
} from '@/services/fdc/fdc-service.js';
import type {
  FoodDetail,
  FoodPortion,
  RawFoodDetail,
  RawFoodPortion,
  RawSearchFood,
  SearchResultFood,
} from '@/services/fdc/types.js';
import {
  createFdcFake,
  FIXTURE_NUTRIENT_COUNT,
  RAW_CUSTARD,
  RAW_KALE,
  RAW_MILK,
  RAW_NOODLES,
  RAW_OLIVE_OIL,
  RAW_ORANGE,
  RAW_TACO,
} from '../../fdc-fake.js';
import { firstText } from '../../helpers.js';

const KALE = 168421;
const SPINACH = 168462;
const ENERGY = 1008;
const PROTEIN = 1003;
const IRON = 1089;
/** Sugars, Total — genuinely absent from both fixture foods, as it is in FDC. */
const SUGARS = 1063;

let http: ReturnType<typeof createFdcFake>;
let service: FdcService;

/** Query parameters the service put on the wire for call `index`. */
function requestParams(index: number): URLSearchParams {
  const call = http.calls[index];
  if (!call) throw new Error(`No upstream call at index ${index}`);
  return new URL(call.request.url).searchParams;
}

/** JSON body the service put on the wire for call `index`. */
async function requestBody(index: number): Promise<Record<string, unknown>> {
  return JSON.parse(await requestText(index)) as Record<string, unknown>;
}

/** Raw body bytes the service put on the wire for call `index`. */
async function requestText(index: number): Promise<string> {
  const call = http.calls[index];
  if (!call) throw new Error(`No upstream call at index ${index}`);
  return call.request.clone().text();
}

/**
 * Normalizes `raw` through the real `getFoodDetail` by serving it from
 * `/food/{fdcId}` over the FDC fake for this one call — for upstream shapes
 * the fake's catalog does not hold.
 */
async function detailOf(raw: RawFoodDetail, nutrientFilter?: number[]): Promise<FoodDetail> {
  const harness = createFetchMock([
    {
      method: 'GET',
      match: (request) => new URL(request.url).pathname === `/fdc/v1/food/${raw.fdcId}`,
      respond: () => Response.json(raw),
    },
  ]);
  harness.install();
  try {
    return await service.getFoodDetail(raw.fdcId, nutrientFilter, createMockContext());
  } finally {
    harness.restore();
  }
}

/** Normalizes one `/foods/search` row through the real `searchFoods`, served for this one call. */
async function searchRowOf(raw: RawSearchFood): Promise<SearchResultFood | undefined> {
  const harness = createFetchMock([
    {
      method: 'POST',
      match: (request) => new URL(request.url).pathname === '/fdc/v1/foods/search',
      respond: () => Response.json({ totalHits: 1, currentPage: 1, totalPages: 1, foods: [raw] }),
    },
  ]);
  harness.install();
  try {
    const { foods } = await service.searchFoods({ query: 'any' }, createMockContext());
    return foods[0];
  } finally {
    harness.restore();
  }
}

describe('FdcService', () => {
  beforeEach(() => {
    vi.stubEnv('USDA_FDC_API_KEY', 'test-key');
    http = createFdcFake();
    http.install();
    service = new FdcService();
  });

  afterEach(() => {
    http.restore();
    vi.unstubAllEnvs();
  });

  describe('getFoodDetail', () => {
    it('returns only the requested nutrient ids', async () => {
      const ctx = createMockContext();
      const food = await service.getFoodDetail(KALE, [ENERGY, PROTEIN], ctx);

      expect(food.nutrients.map((n) => n.id)).toEqual([ENERGY, PROTEIN]);
      expect(food.nutrients).toEqual([
        { id: ENERGY, name: 'Energy', number: '208', amount: 35, unit: 'kcal' },
        { id: PROTEIN, name: 'Protein', number: '203', amount: 2.92, unit: 'g' },
      ]);
    });

    it('never sends nutrient ids to the upstream nutrients filter', async () => {
      const ctx = createMockContext();
      await service.getFoodDetail(KALE, [ENERGY, PROTEIN], ctx);

      // FDC's `nutrients` parameter matches SR numbers ("208"), so any id-space
      // value sent here comes back as an empty foodNutrients[].
      expect(requestParams(0).getAll('nutrients')).toEqual([]);
    });

    it('returns every nutrient when no filter is given', async () => {
      const ctx = createMockContext();
      const food = await service.getFoodDetail(KALE, undefined, ctx);

      expect(food.nutrients).toHaveLength(FIXTURE_NUTRIENT_COUNT);
      expect(food.nutrients.map((n) => n.id)).toContain(IRON);
    });

    it('treats an empty filter as no filter', async () => {
      const ctx = createMockContext();
      const food = await service.getFoodDetail(KALE, [], ctx);

      expect(food.nutrients).toHaveLength(FIXTURE_NUTRIENT_COUNT);
    });

    it('omits a nutrient the food genuinely lacks while keeping the rest', async () => {
      const ctx = createMockContext();
      const food = await service.getFoodDetail(KALE, [PROTEIN, SUGARS], ctx);

      expect(food.nutrients.map((n) => n.id)).toEqual([PROTEIN]);
    });

    it('returns an empty nutrient list when no requested id is present', async () => {
      const ctx = createMockContext();
      const food = await service.getFoodDetail(KALE, [SUGARS], ctx);

      expect(food.nutrients).toEqual([]);
      expect(food.description).toBe('Kale, raw');
    });

    it('normalizes nested category, portion, and nutrient sub-objects', async () => {
      const ctx = createMockContext();
      const food = await service.getFoodDetail(SPINACH, undefined, ctx);

      expect(food.foodCategory).toBe('Vegetables and Vegetable Products');
      expect(food.portions).toEqual([
        { description: '1 bunch', gramWeight: 340, amount: 1 },
        { description: '1 leaf', gramWeight: 10, amount: 1 },
      ]);
      const iron = food.nutrients.find((n) => n.id === IRON);
      expect(iron).toEqual({
        id: IRON,
        name: 'Iron, Fe',
        number: '303',
        amount: 2.71,
        unit: 'mg',
      });
    });

    it('reads a string foodCategory, trimmed', async () => {
      const food = await detailOf({ ...RAW_KALE, foodCategory: '  Snacks  ' });

      expect(food.foodCategory).toBe('Snacks');
    });

    it('drops portions without a positive gram weight and keeps FDC order', async () => {
      const food = await detailOf({
        ...RAW_KALE,
        foodPortions: [
          { gramWeight: 0, modifier: 'cup' },
          { gramWeight: 12 },
          { gramWeight: -3, modifier: 'slice' },
          { gramWeight: 5, portionDescription: '1 piece' },
        ],
      });

      expect(food.portions).toEqual([
        { description: 'Serving', gramWeight: 12 },
        { description: '1 piece', gramWeight: 5 },
      ]);
    });
  });

  describe('getFoodsBatch', () => {
    it('returns the requested nutrient ids for every food', async () => {
      const ctx = createMockContext();
      const { foods, failed } = await service.getFoodsBatch(
        [KALE, SPINACH],
        [ENERGY, PROTEIN],
        ctx,
      );

      expect(failed).toEqual([]);
      expect(foods.map((f) => f.fdcId)).toEqual([KALE, SPINACH]);
      for (const food of foods) {
        expect(food.nutrients.map((n) => n.id)).toEqual([ENERGY, PROTEIN]);
      }
      expect(foods[0]?.nutrients[0]?.amount).toBe(35);
      expect(foods[1]?.nutrients[0]?.amount).toBe(23);
    });

    it('never sends nutrient ids to the upstream nutrients filter', async () => {
      const ctx = createMockContext();
      await service.getFoodsBatch([KALE, SPINACH], [ENERGY, PROTEIN], ctx);

      await expect(requestBody(0)).resolves.toEqual({ fdcIds: [KALE, SPINACH] });
    });

    it('reports ids the batch endpoint did not return', async () => {
      const ctx = createMockContext();
      const { foods, failed } = await service.getFoodsBatch([KALE, 999_999], [PROTEIN], ctx);

      expect(foods.map((f) => f.fdcId)).toEqual([KALE]);
      expect(failed).toEqual([
        { fdcId: 999_999, error: 'FDC ID 999999 not found or returned no data.' },
      ]);
    });

    it('omits a nutrient the foods genuinely lack', async () => {
      const ctx = createMockContext();
      const { foods } = await service.getFoodsBatch([KALE, SPINACH], [PROTEIN, SUGARS], ctx);

      for (const food of foods) {
        expect(food.nutrients.map((n) => n.id)).toEqual([PROTEIN]);
      }
    });

    /**
     * FDC answers HTTP 200 `{}` instead of `[]` when it knows none of the
     * requested IDs — for one unknown ID, several, or none at all.
     */
    it('reads a 200 {} as zero matches and fails every requested ID', async () => {
      const { foods, failed } = await service.getFoodsBatch(
        [999_999_998, 999_999_999],
        [PROTEIN],
        createMockContext(),
      );

      expect(foods).toEqual([]);
      expect(failed).toStrictEqual([
        { fdcId: 999_999_998, error: 'FDC ID 999999998 not found or returned no data.' },
        { fdcId: 999_999_999, error: 'FDC ID 999999999 not found or returned no data.' },
      ]);
    });

    it.each([
      ['an object with keys', { foods: [] }],
      ['null', null],
      ['a string', 'ok'],
      ['a number', 0],
    ])(
      'fails a 200 body that is %s as ServiceUnavailable without retrying',
      async (_label, body) => {
        const upstream = createFetchMock([
          {
            method: 'POST',
            match: (request) => new URL(request.url).pathname === '/fdc/v1/foods',
            respond: () => Response.json(body),
          },
        ]);
        upstream.install();
        try {
          await expect(
            service.getFoodsBatch([KALE, SPINACH], undefined, createMockContext()),
          ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
          expect(upstream.calls).toHaveLength(1);
        } finally {
          upstream.restore();
        }
      },
    );
  });

  /**
   * One description rule for every data type: FNDDS's `portionDescription` as
   * sent; otherwise the positive `amount`, the measure unit unless FDC's
   * `undetermined` placeholder (RACC spelled out), and the modifier unless an
   * all-digit FNDDS code; `Serving` when nothing remains.
   */
  describe('portion descriptions', () => {
    it.each<[string, RawFoodDetail, FoodPortion[]]>([
      [
        'an SR Legacy half cup',
        RAW_CUSTARD,
        [{ description: '0.5 cup', gramWeight: 141, amount: 0.5 }],
      ],
      [
        'SR Legacy portions in FDC order',
        RAW_NOODLES,
        [
          { description: '2 oz', gramWeight: 57, amount: 2 },
          { description: '1 cup', gramWeight: 38, amount: 1 },
        ],
      ],
      [
        'Foundation measure units and a RACC',
        RAW_ORANGE,
        [
          { description: '1 cup sections no membranes', gramWeight: 165, amount: 1 },
          { description: '1 each 2-7/8" dia', gramWeight: 140, amount: 1 },
          {
            description: '1 RACC (reference amount customarily consumed)',
            gramWeight: 140,
            amount: 1,
          },
        ],
      ],
      [
        'FNDDS described portions, which carry no amount',
        RAW_TACO,
        [
          { description: '1 small/regular', gramWeight: 105 },
          { description: '1 large', gramWeight: 160 },
          { description: 'Quantity not specified', gramWeight: 105 },
        ],
      ],
    ])('describes %s', async (_label, raw, expected) => {
      const food = await service.getFoodDetail(raw.fdcId, undefined, createMockContext());

      expect(food.portions).toStrictEqual(expected);
    });

    const UNDETERMINED = { id: 9999, name: 'undetermined', abbreviation: 'undetermined' };

    it.each<[string, RawFoodPortion, FoodPortion]>([
      [
        'a zero amount, neither rendered nor carried',
        { amount: 0, gramWeight: 30, modifier: 'cup', measureUnit: UNDETERMINED },
        { description: 'cup', gramWeight: 30 },
      ],
      [
        'a negative amount',
        { amount: -1, gramWeight: 30, modifier: 'cup', measureUnit: UNDETERMINED },
        { description: 'cup', gramWeight: 30 },
      ],
      [
        'an all-digit modifier dropped beside an amount',
        { amount: 2, gramWeight: 50, modifier: '10205', measureUnit: UNDETERMINED },
        { description: '2', gramWeight: 50, amount: 2 },
      ],
      [
        'a modifier mixing digits and text, kept and trimmed',
        { amount: 1, gramWeight: 28, modifier: '  slice (1 oz) ', measureUnit: UNDETERMINED },
        { description: '1 slice (1 oz)', gramWeight: 28, amount: 1 },
      ],
      [
        'a blank portionDescription, falling through to the parts',
        { portionDescription: '   ', amount: 3, gramWeight: 45, modifier: 'pieces' },
        { description: '3 pieces', gramWeight: 45, amount: 3 },
      ],
      [
        'a portionDescription beside an amount, the description as sent',
        { portionDescription: ' 1 cup, diced ', amount: 1, gramWeight: 150, modifier: '12345' },
        { description: '1 cup, diced', gramWeight: 150, amount: 1 },
      ],
      [
        'a RACC without an amount',
        { gramWeight: 30, measureUnit: { id: 1121, name: 'RACC', abbreviation: 'RACC' } },
        { description: 'RACC (reference amount customarily consumed)', gramWeight: 30 },
      ],
      [
        'only placeholders',
        { gramWeight: 10, modifier: '90000', measureUnit: UNDETERMINED },
        { description: 'Serving', gramWeight: 10 },
      ],
    ])('handles %s', async (_label, portion, expected) => {
      const food = await detailOf({ ...RAW_KALE, foodPortions: [portion] });

      expect(food.portions).toStrictEqual([expected]);
    });
  });

  /** Branded values are per 100 g or per 100 ml by label unit; every other data type is per 100 g. */
  describe('basis unit', () => {
    it.each([
      ['SR Legacy detail per 100 g', RAW_KALE, 'g'],
      ['Survey (FNDDS) detail per 100 g', RAW_TACO, 'g'],
      ['a Branded ml label per 100 ml', RAW_MILK, 'ml'],
    ] as const)('marks %s', async (_label, raw, expected) => {
      const food = await service.getFoodDetail(raw.fdcId, undefined, createMockContext());

      expect(food.basisUnit).toBe(expected);
    });

    it('marks a Branded gram label g and omits the basis for an unverified label unit', async () => {
      await expect(detailOf({ ...RAW_MILK, servingSizeUnit: 'GRM' })).resolves.toMatchObject({
        basisUnit: 'g',
      });
      await expect(detailOf({ ...RAW_MILK, servingSizeUnit: 'IU' })).resolves.not.toHaveProperty(
        'basisUnit',
      );
      const { servingSizeUnit: _unit, ...noUnit } = RAW_MILK;
      await expect(detailOf(noUnit)).resolves.not.toHaveProperty('basisUnit');
    });

    it('carries the basis through the batch path', async () => {
      const { foods } = await service.getFoodsBatch(
        [RAW_OLIVE_OIL.fdcId, KALE],
        undefined,
        createMockContext(),
      );

      expect(foods.map((f) => f.basisUnit)).toEqual(['ml', 'g']);
    });

    it.each<[string, Partial<RawSearchFood>, string | undefined]>([
      ['an SR Legacy row per 100 g', { dataType: 'SR Legacy' }, 'g'],
      [
        'a Branded MLT row per 100 ml',
        { dataType: 'Branded', servingSize: 240, servingSizeUnit: 'MLT' },
        'ml',
      ],
      [
        'a Branded IU row with no basis',
        { dataType: 'Branded', servingSize: 57, servingSizeUnit: 'IU' },
        undefined,
      ],
    ])('marks %s', async (_label, fields, expected) => {
      const row = await searchRowOf({ fdcId: 1, description: 'Row', ...fields });

      expect(row?.basisUnit).toBe(expected);
      expect(Object.hasOwn(row ?? {}, 'basisUnit')).toBe(expected !== undefined);
    });
  });

  describe('gtinUpc', () => {
    it('carries a Branded GTIN as the string FDC sends, leading zeros kept', async () => {
      const milk = await service.getFoodDetail(RAW_MILK.fdcId, undefined, createMockContext());
      const { foods } = await service.getFoodsBatch(
        [RAW_OLIVE_OIL.fdcId, KALE],
        undefined,
        createMockContext(),
      );

      expect(milk.gtinUpc).toBe('02114029705');
      expect(foods[0]?.gtinUpc).toBe('011110044174');
      expect(foods[1]).not.toHaveProperty('gtinUpc');
    });

    it('carries a search row GTIN and omits one FDC does not send', async () => {
      await expect(
        searchRowOf({
          fdcId: 2078244,
          description: 'MILK',
          dataType: 'Branded',
          gtinUpc: '02114029705',
        }),
      ).resolves.toMatchObject({ gtinUpc: '02114029705' });
      await expect(
        searchRowOf({ fdcId: 171077, description: 'Chicken', dataType: 'SR Legacy' }),
      ).resolves.not.toHaveProperty('gtinUpc');
    });
  });

  /** FDC sends the category under a different field per data type. */
  describe('food category', () => {
    it.each([
      ['Branded brandedFoodCategory', RAW_MILK, 'Milk'],
      ['Branded brandedFoodCategory', RAW_OLIVE_OIL, 'Vegetable & Cooking Oils'],
      ['FNDDS wweiaFoodCategory', RAW_TACO, 'Burritos and tacos'],
      ['SR Legacy foodCategory', RAW_CUSTARD, 'Sweets'],
    ])('reads the %s %#', async (_field, raw, expected) => {
      const food = await service.getFoodDetail(raw.fdcId, undefined, createMockContext());

      expect(food.foodCategory).toBe(expected);
    });

    it('takes the first present field, skipping blanks, trimmed', async () => {
      await expect(
        detailOf({ ...RAW_MILK, foodCategory: { description: 'Dairy and Egg Products' } }),
      ).resolves.toMatchObject({ foodCategory: 'Dairy and Egg Products' });
      await expect(
        detailOf({ ...RAW_MILK, foodCategory: '  ', brandedFoodCategory: ' Milk ' }),
      ).resolves.toMatchObject({ foodCategory: 'Milk' });
      await expect(
        detailOf({
          ...RAW_TACO,
          foodCategory: { description: ' ' },
          wweiaFoodCategory: { wweiaFoodCategoryDescription: ' Burritos and tacos ' },
        }),
      ).resolves.toMatchObject({ foodCategory: 'Burritos and tacos' });
    });

    it('omits the category when every field is absent or blank', async () => {
      await expect(
        detailOf({
          ...RAW_TACO,
          brandedFoodCategory: ' ',
          wweiaFoodCategory: { wweiaFoodCategoryDescription: '  ' },
        }),
      ).resolves.not.toHaveProperty('foodCategory');
      const { wweiaFoodCategory: _category, ...bare } = RAW_TACO;
      await expect(detailOf(bare)).resolves.not.toHaveProperty('foodCategory');
    });

    it('carries the category through the batch path', async () => {
      const { foods } = await service.getFoodsBatch(
        [RAW_TACO.fdcId, RAW_MILK.fdcId],
        undefined,
        createMockContext(),
      );

      expect(foods.map((f) => f.foodCategory)).toEqual(['Burritos and tacos', 'Milk']);
    });
  });

  /** Requested nutrient IDs a food's returned profile does not report. */
  describe('missingNutrients', () => {
    it('lists requested IDs the profile lacks, deduplicated, in request order', async () => {
      const food = await service.getFoodDetail(
        KALE,
        [SUGARS, PROTEIN, 99_999, SUGARS, 99_999],
        createMockContext(),
      );

      expect(food.nutrients.map((n) => n.id)).toEqual([PROTEIN]);
      expect(food.missingNutrients).toEqual([SUGARS, 99_999]);
    });

    it('names the only requested ID when the food lacks it', async () => {
      const food = await service.getFoodDetail(KALE, [SUGARS], createMockContext());

      expect(food.nutrients).toEqual([]);
      expect(food.missingNutrients).toEqual([SUGARS]);
    });

    it.each([
      ['every requested ID is present', [ENERGY, PROTEIN]],
      ['no filter is given', undefined],
      ['the filter is empty', []],
    ])('is omitted when %s', async (_label, filter) => {
      const food = await service.getFoodDetail(KALE, filter, createMockContext());

      expect(food).not.toHaveProperty('missingNutrients');
    });

    it('counts an entry FDC sends without an amount as unreported', async () => {
      const food = await detailOf(
        {
          ...RAW_KALE,
          foodNutrients: [
            { nutrient: { id: PROTEIN, number: '203', name: 'Protein', unitName: 'g' } },
          ],
        },
        [PROTEIN],
      );

      expect(food.nutrients).toEqual([]);
      expect(food.missingNutrients).toEqual([PROTEIN]);
    });

    it('rides each batch food, never a failed entry', async () => {
      const { foods, failed } = await service.getFoodsBatch(
        [KALE, 999_999, SPINACH],
        [PROTEIN, SUGARS],
        createMockContext(),
      );

      expect(foods.map((f) => f.missingNutrients)).toEqual([[SUGARS], [SUGARS]]);
      expect(failed).toStrictEqual([
        { fdcId: 999_999, error: 'FDC ID 999999 not found or returned no data.' },
      ]);
    });
  });

  /**
   * FDC parses `/foods/search` `query` as Lucene syntax and answers a bare 400
   * for a lone `/`, an unpaired `"`, `(`, or `)`, and brackets or braces outside
   * a range, so the service escapes exactly those and sends every other
   * operator — well-formed `/regex/` and `[a TO b]` range terms included —
   * untouched. Asserted on the body the fetch receives.
   */
  describe('searchFoods query on the wire', () => {
    const SEARCH_PATH = '/fdc/v1/foods/search';
    const isSearch = (request: Request) => new URL(request.url).pathname === SEARCH_PATH;

    /** Routes `/foods/search` to `respond` on the installed FDC fake. */
    function routeSearch(respond: () => Response) {
      http.route({ method: 'POST', match: isSearch, respond });
    }

    const emptyPage = () =>
      Response.json({ totalHits: 0, currentPage: 1, totalPages: 0, foods: [] });

    async function wireQuery(query: string): Promise<unknown> {
      routeSearch(emptyPage);
      await service.searchFoods({ query }, createMockContext());
      return (await requestBody(0)).query;
    }

    it.each([
      [
        'Beef, top sirloin, steak, separable lean and fat, trimmed to 1/8" fat, choice, cooked, broiled',
        'Beef, top sirloin, steak, separable lean and fat, trimmed to 1\\/8\\" fat, choice, cooked, broiled',
      ],
      ['beef (cooked', 'beef \\(cooked'],
      ['beef cooked)', 'beef cooked\\)'],
      ['beef [cooked]', 'beef \\[cooked\\]'],
      ['beef {cooked}', 'beef \\{cooked\\}'],
      ['beef 1/8 cooked 1/4', 'beef 1\\/8 cooked 1\\/4'],
      // Pairing is by depth: a closer before its opener pairs with nothing.
      ['beef )cooked(', 'beef \\)cooked\\('],
      // Only the stray closer is escaped; the balanced group keeps its meaning.
      ['(beef OR pork) AND raw)', '(beef OR pork) AND raw\\)'],
      // An escaped quote is not counted, so the one unescaped quote is odd.
      ['\\"a" b', '\\"a\\" b'],
      ['say "a" and "b', 'say \\"a\\" and \\"b'],
      // An escaped backslash leaves the paren after it unescaped and unpaired.
      ['beef \\\\(raw', 'beef \\\\\\(raw'],
      // A slash that is not part of a well-formed regex term.
      ['/', '\\/'],
      ['w/o salt', 'w\\/o salt'],
      ['/beef', '\\/beef'],
      ['beef/', 'beef\\/'],
      ['1/2 /chick.*/', '1\\/2 /chick.*/'],
      ['/chick en/', '\\/chick en\\/'],
      ['/beef/x', '\\/beef\\/x'],
      ['a/b/', 'a\\/b\\/'],
      // A bracket or brace that is not part of a well-formed range term.
      ['beef [raw]', 'beef \\[raw\\]'],
      ['beef ]', 'beef \\]'],
      ['[a TO c', '\\[a TO c'],
      ['[a TO]', '\\[a TO\\]'],
      ['[a to c]', '\\[a to c\\]'],
      ['[a TO c]x', '\\[a TO c\\]x'],
      ['x[a TO c]', 'x\\[a TO c\\]'],
    ])('escapes %j as %j', async (query, expected) => {
      await expect(wireQuery(query)).resolves.toBe(expected);
    });

    it.each([
      '"ground beef"',
      'beef -raw',
      '(beef OR pork) AND raw',
      'chick*',
      'beeef~',
      'beef^5 raw',
      'description:beef',
      '012345678901',
      'beef +raw && lean || !fried NOT smoked',
      // Already escaped — never double-escaped.
      'trimmed to 1\\/8\\" fat',
      'beef \\(cooked',
      // A parenthesis inside a balanced phrase is literal to Lucene.
      '"beef (raw" lean',
      // A trailing lone backslash is sent as-is; FDC rejects it as query_syntax.
      'beef \\',
      // Regex terms: opener at a term start, closer at a term end, no whitespace in the body.
      '/chick.*/',
      'beef /chick.*/',
      'description:/chick.*/',
      '(/chick.*/)',
      '-/chick.*/ +/beef/ !/pork/',
      '/chick.*/^2 /beef/~',
      '/a\\/b/',
      // Range terms, inclusive or exclusive on either side.
      'description:[a TO c]',
      '[a TO c]',
      '{a TO c}',
      '[* TO c]',
      '[a TO c}^2',
      'fdcId:[100000 TO 200000]',
      // Slashes and brackets inside a balanced phrase are literal to Lucene.
      '"1/8" fat',
      '"beef [raw]"',
    ])('sends %j unchanged', async (query) => {
      await expect(wireQuery(query)).resolves.toBe(query);
    });

    describe('request body beyond query', () => {
      it('sends a body with no filter or option byte for byte as 0.2.0 did', async () => {
        routeSearch(emptyPage);
        await service.searchFoods({ query: 'kale', dataType: ['SR Legacy'] }, createMockContext());

        await expect(requestText(0)).resolves.toBe(
          '{"query":"kale","pageSize":10,"pageNumber":1,"dataType":["SR Legacy"]}',
        );
      });

      it.each([
        ['brandOwner', 'Kellog*', 'Kellog*'],
        ['brandOwner', '  Kellog*  ', 'Kellog*'],
        ['foodCategory', 'Poult?y Products', 'Poult?y Products'],
        // A wildcard value is sent as written, escapes and quotes included.
        ['brandOwner', 'Ben*Jerry"s \\', 'Ben*Jerry"s \\'],
      ] as const)('sends wildcard %s %j unquoted as %j', async (field, value, expected) => {
        routeSearch(emptyPage);
        await service.searchFoods({ query: 'cereal', [field]: value }, createMockContext());

        expect((await requestBody(0))[field]).toBe(expected);
      });

      it.each(['', '   '])('keeps blank filters %j off the wire', async (value) => {
        routeSearch(emptyPage);
        await service.searchFoods(
          { query: 'cereal', brandOwner: value, foodCategory: value },
          createMockContext(),
        );

        expect(Object.keys(await requestBody(0))).toEqual(['query', 'pageSize', 'pageNumber']);
      });

      /**
       * FDC parses each filter as a Lucene query that ORs its words, so a
       * multi-word value goes as one quoted phrase.
       */
      it.each([
        ['brandOwner', 'Kellogg Company', '"Kellogg Company"'],
        ['brandOwner', '  Kellogg Company  ', '"Kellogg Company"'],
        ['brandOwner', 'Kellogg Company\\', '"Kellogg Company\\\\"'],
        ['brandOwner', 'Kellogg "Company"', '"Kellogg \\"Company\\""'],
        ['brandOwner', 'Kellogg "Company', '"Kellogg \\"Company"'],
        // One pass: a backslash before a quote is escaped once, the quote once.
        ['brandOwner', 'a\\"b', '"a\\\\\\"b"'],
        ['brandOwner', "Ben & Jerry's Homemade Inc.", '"Ben & Jerry\'s Homemade Inc."'],
        ['brandOwner', 'Wal-Mart Stores, Inc.', '"Wal-Mart Stores, Inc."'],
        ['foodCategory', 'Poultry Products', '"Poultry Products"'],
        [
          'foodCategory',
          'Vegetables (raw) [fresh] +AND -OR',
          '"Vegetables (raw) [fresh] +AND -OR"',
        ],
      ] as const)('sends %s %j as the phrase %j', async (field, value, expected) => {
        routeSearch(emptyPage);
        await service.searchFoods({ query: 'cereal', [field]: value }, createMockContext());

        expect((await requestBody(0))[field]).toBe(expected);
      });

      it('leaves query escaping unchanged beside a phrase filter', async () => {
        routeSearch(emptyPage);
        await service.searchFoods(
          { query: 'beef (raw', brandOwner: 'Kellogg Company', foodCategory: 'Beef Products' },
          createMockContext(),
        );

        await expect(requestText(0)).resolves.toBe(
          '{"query":"beef \\\\(raw","pageSize":10,"pageNumber":1,"brandOwner":"\\"Kellogg Company\\"","foodCategory":"\\"Beef Products\\""}',
        );
      });

      it('adds requireAllWords only when it is true', async () => {
        routeSearch(emptyPage);
        const ctx = createMockContext();
        await service.searchFoods({ query: 'rice brown cooked', requireAllWords: true }, ctx);
        await service.searchFoods({ query: 'rice brown cooked', requireAllWords: false }, ctx);
        await service.searchFoods({ query: 'rice brown cooked' }, ctx);

        await expect(requestText(0)).resolves.toBe(
          '{"query":"rice brown cooked","pageSize":10,"pageNumber":1,"requireAllWords":true}',
        );
        const unset = '{"query":"rice brown cooked","pageSize":10,"pageNumber":1}';
        await expect(requestText(1)).resolves.toBe(unset);
        await expect(requestText(2)).resolves.toBe(unset);
      });
    });

    it('exports the 100,000-result window FDC pages within', () => {
      expect(FDC_RESULT_WINDOW).toBe(100_000);
    });

    it('fails a 400 as query_syntax naming the query, never the URL or key', async () => {
      routeSearch(() =>
        Response.json(
          { error: 'Bad Request', message: 'Invalid request. Please try again.' },
          { status: 400 },
        ),
      );

      const error = await service
        .searchFoods({ query: 'beef AND' }, createMockContext())
        .catch((e: unknown) => e);

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: 'FDC rejected the query syntax of "beef AND".',
        data: { reason: 'query_syntax', query: 'beef AND' },
      });
      expect(JSON.stringify((error as { data?: unknown }).data)).not.toMatch(/https?:|test-key/);
      expect(http.calls).toHaveLength(1);
    });

    it.each([
      [403, {}, JsonRpcErrorCode.Forbidden],
      // A Retry-After past maxDelayMs fails fast, so no retry ladder runs.
      [429, { 'Retry-After': '120' }, JsonRpcErrorCode.RateLimited],
    ])('leaves a %i from search classified as before', async (code, headers, expected) => {
      routeSearch(() => Response.json({ error: 'upstream' }, { status: code, headers }));

      await expect(
        service.searchFoods({ query: 'kale' }, createMockContext()),
      ).rejects.toMatchObject({ code: expected, data: { status: code } });
    });

    it('carries the declared recovery to both surfaces of usda_search_foods', async () => {
      initFdcService();
      routeSearch(() => Response.json({ error: 'Bad Request' }, { status: 400 }));

      const result = await runToolContract(usdaSearchFoods, { query: 'beef AND' });

      const hint =
        'FDC rejected the query syntax. Remove a leading or trailing operator (AND, OR, -, !, ^) or a trailing backslash, or put a backslash before a character meant literally.';
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message: 'FDC rejected the query syntax of "beef AND".',
          data: { reason: 'query_syntax', recovery: { hint } },
        },
      });
      const text = firstText(result.content);
      expect(text).toContain('FDC rejected the query syntax of "beef AND".');
      expect(text).toContain(`Recovery: ${hint}`);
    });
  });

  /**
   * `query` has no length cap, so the escaper must stay linear on its worst
   * shapes. Each shape doubles from 10k to 320k characters against a 5k
   * baseline (64×), and every size must fit a per-character CPU budget and grow
   * under 256× the baseline — a quadratic pass shows 4096× — before the next
   * size runs. Each measurement times a batch of calls, so a 5k call is not read
   * below the timer's resolution, and keeps the least of three batches. The
   * baseline is re-timed beside every size and the least growth across those
   * pairs is asserted, so a move between a performance and an efficiency core
   * between two measurements cannot fail linear work.
   */
  describe('escapeFdcQuery timing', () => {
    const BASE = 5_000;
    const SIZES = [10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
    /** Linear work at any size — about 1 µs a character plus fixed overhead. */
    const budgetUs = (size: number) => 5_000 + size;

    /** Builds a string of about `size` characters by repeating `unit`. */
    const repeat = (unit: string, size: number, tail = '') =>
      unit.repeat(Math.ceil(size / unit.length)) + tail;

    const SHAPES: ReadonlyArray<readonly [string, (size: number) => string]> = [
      ['repeated opener, no closer', (size) => repeat('(', size)],
      ['nested openers', (size) => `${repeat('(a', size / 2)}${repeat(')', size / 4)}`],
      ['closer before opener', (size) => repeat(')(', size)],
      ['run of backslashes', (size) => repeat('\\', size)],
      ['run of odd quotes', (size) => repeat('"', size, '"')],
      ['overlapping escape, quote, paren', (size) => repeat('\\"(', size)],
      ['slashes and brackets', (size) => repeat('/[{', size)],
      ['term-start slashes, no closer', (size) => repeat(' /a', size)],
      ['slashes after group openers', (size) => repeat('(/', size)],
      ['repeated [a TO, no closer', (size) => repeat('[a TO ', size)],
      ['range openers after group openers', (size) => repeat('([a', size)],
      ['one long line ending in a break', (size) => `${repeat('§1 x', size)}\ny`],
      ['breaks throughout', (size) => repeat('  \r\n', size)],
    ];

    /** Keeps every result observable, so no call can be optimized away. */
    let sink = 0;

    /** Least thread CPU time per call, in µs, over three batches of about 320k characters each. */
    function perCallMicros(input: string): number {
      const calls = Math.max(1, Math.round(320_000 / input.length));
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run++) {
        const start = process.threadCpuUsage();
        for (let call = 0; call < calls; call++) sink += escapeFdcQuery(input).length;
        const used = process.threadCpuUsage(start);
        best = Math.min(best, (used.user + used.system) / calls);
      }
      return best;
    }

    it.each(SHAPES)('stays linear on %s', (_shape, build) => {
      const base = build(BASE);
      perCallMicros(base); // warm the JIT before measuring
      for (const size of SIZES) {
        const input = build(size);
        let least = Number.POSITIVE_INFINITY;
        let growth = Number.POSITIVE_INFINITY;
        for (let pair = 0; pair < 2; pair++) {
          const baseline = Math.max(perCallMicros(base), 0.01);
          const elapsed = perCallMicros(input);
          least = Math.min(least, elapsed);
          growth = Math.min(growth, elapsed / baseline);
        }
        expect(least, `${size} chars`).toBeLessThan(budgetUs(size));
        expect(growth, `${size} chars against ${BASE}`).toBeLessThan(256);
      }
      expect(sink).toBeGreaterThan(0);
    });

    it('escapes the worst shapes as specified', () => {
      expect(escapeFdcQuery('((')).toBe('\\(\\(');
      expect(escapeFdcQuery(')(')).toBe('\\)\\(');
      expect(escapeFdcQuery('\\\\\\')).toBe('\\\\\\');
      expect(escapeFdcQuery('"""')).toBe('\\"\\"\\"');
      expect(escapeFdcQuery('\\"(')).toBe('\\"\\(');
      expect(escapeFdcQuery(' /a /a')).toBe(' \\/a \\/a');
      expect(escapeFdcQuery('(/(/(')).toBe('\\(\\/\\(\\/\\(');
      expect(escapeFdcQuery('[a TO [a TO ')).toBe('\\[a TO \\[a TO ');
      expect(escapeFdcQuery('([a([a')).toBe('\\(\\[a\\(\\[a');
    });
  });

  /**
   * `brandOwner` and `foodCategory` have no length cap, so the filter encoder
   * must stay linear. Each shape doubles from 10k to 320k characters against a
   * 5k baseline (64×), and every size must fit a per-character CPU budget and
   * grow under 256× the baseline — a quadratic pass shows 4096× — before the
   * next size runs. Each measurement times a batch of calls, so a 5k call is not
   * read below the timer's resolution, and keeps the least of three batches.
   * The baseline is re-timed beside every size and the least growth across
   * those pairs is asserted, so a move between a performance and an efficiency
   * core between two measurements cannot fail linear work.
   */
  describe('encodeFdcFilter timing', () => {
    const BASE = 5_000;
    const SIZES = [10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
    /** Linear work at any size — about 1 µs a character plus fixed overhead. */
    const budgetUs = (size: number) => 5_000 + size;

    /** Builds a string of about `size` characters by repeating `unit`. */
    const repeat = (unit: string, size: number, tail = '') =>
      unit.repeat(Math.ceil(size / unit.length)) + tail;

    const SHAPES: ReadonlyArray<readonly [string, (size: number) => string]> = [
      ['run of backslashes', (size) => repeat('\\', size)],
      ['run of quotes', (size) => repeat('"', size)],
      ['alternating backslash and quote', (size) => repeat('\\"', size)],
      ['long digit run', (size) => repeat('7', size)],
      ['asterisk after a long run', (size) => repeat('a', size, '*')],
      ['question mark after a long run', (size) => repeat('a', size, '?')],
      ['one long line ending in a break', (size) => `${repeat('§1 x', size)}\ny`],
      ['breaks throughout', (size) => repeat('  \r\n', size)],
    ];

    /** Keeps every result observable, so no call can be optimized away. */
    let sink = 0;

    /** Least thread CPU time per call, in µs, over three batches of about 320k characters each. */
    function perCallMicros(input: string): number {
      const calls = Math.max(1, Math.round(320_000 / input.length));
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run++) {
        const start = process.threadCpuUsage();
        for (let call = 0; call < calls; call++) sink += encodeFdcFilter(input).length;
        const used = process.threadCpuUsage(start);
        best = Math.min(best, (used.user + used.system) / calls);
      }
      return best;
    }

    it.each(SHAPES)('stays linear on %s', (_shape, build) => {
      const base = build(BASE);
      perCallMicros(base); // warm the JIT before measuring
      for (const size of SIZES) {
        const input = build(size);
        let least = Number.POSITIVE_INFINITY;
        let growth = Number.POSITIVE_INFINITY;
        for (let pair = 0; pair < 2; pair++) {
          const baseline = Math.max(perCallMicros(base), 0.01);
          const elapsed = perCallMicros(input);
          least = Math.min(least, elapsed);
          growth = Math.min(growth, elapsed / baseline);
        }
        expect(least, `${size} chars`).toBeLessThan(budgetUs(size));
        expect(growth, `${size} chars against ${BASE}`).toBeLessThan(256);
      }
      expect(sink).toBeGreaterThan(0);
    });

    it('encodes the timed shapes as specified', () => {
      expect(encodeFdcFilter('\\\\')).toBe('"\\\\\\\\"');
      expect(encodeFdcFilter('""')).toBe('"\\"\\""');
      expect(encodeFdcFilter('\\"')).toBe('"\\\\\\""');
      expect(encodeFdcFilter('aa*')).toBe('aa*');
      expect(encodeFdcFilter('aa?')).toBe('aa?');
      expect(encodeFdcFilter('§1 x\ny')).toBe('"§1 x\ny"');
      expect(encodeFdcFilter('  \r\n')).toBe('"  \r\n"');
    });
  });

  /**
   * A 404 from the single-food endpoint is the declared `not_found` outcome for
   * a caller-supplied id, so it must not inflate the error rate. The opt-out is
   * scoped to that one request — `/foods` and `/foods/search` answer 200 for a
   * bad id, so a 404 from either is a genuine anomaly and stays at `error`.
   * A 400 from `/foods/search` is FDC refusing the caller's query syntax — the
   * declared `query_syntax` outcome — and logs at `debug` the same way.
   */
  describe('expected-status log level', () => {
    /**
     * `fetchWithTimeout` logs to the framework's module-level logger, not to
     * `ctx.log`, so the severity it chose is only observable by spying there.
     */
    function spyOnFetchLogging() {
      return {
        error: vi.spyOn(logger, 'error').mockImplementation(() => {}),
        debug: vi.spyOn(logger, 'debug').mockImplementation(() => {}),
      };
    }

    /**
     * Log calls whose payload carries the HTTP status the fetch layer saw. The
     * fetch layer attaches it through `withExtra`, so it lands under the
     * context's `extra` bag — flattened again only when the line is emitted.
     */
    function statusCalls(spy: { mock: { calls: unknown[][] } }, status: number): unknown[][] {
      return spy.mock.calls.filter(
        (call) =>
          (call[1] as { extra?: { statusCode?: number } } | undefined)?.extra?.statusCode ===
          status,
      );
    }

    afterEach(() => vi.restoreAllMocks());

    it('logs a missing-food 404 at debug, not error', async () => {
      const log = spyOnFetchLogging();

      await expect(
        service.getFoodDetail(999_999, undefined, createMockContext()),
      ).rejects.toThrow();

      expect(statusCalls(log.debug, 404)).toHaveLength(1);
      expect(statusCalls(log.error, 404)).toHaveLength(0);
    });

    it('still throws the status-mapped error for a missing food', async () => {
      await expect(
        service.getFoodDetail(999_999, undefined, createMockContext()),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
    });

    it('keeps a 404 on the batch path at error', async () => {
      const batch404 = createFetchMock([
        {
          method: 'POST',
          match: (request) => new URL(request.url).pathname.endsWith('/foods'),
          respond: () => Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 }),
        },
      ]);
      batch404.install();
      try {
        const log = spyOnFetchLogging();

        await expect(
          service.getFoodsBatch([KALE], [PROTEIN], createMockContext()),
        ).rejects.toThrow();

        expect(statusCalls(log.error, 404)).toHaveLength(1);
        expect(statusCalls(log.debug, 404)).toHaveLength(0);
      } finally {
        batch404.restore();
      }
    });

    it('logs a search 400 at debug, not error', async () => {
      http.route({
        method: 'POST',
        match: (request) => new URL(request.url).pathname.endsWith('/foods/search'),
        respond: () => Response.json({ error: 'Bad Request' }, { status: 400 }),
      });
      const log = spyOnFetchLogging();

      await expect(
        service.searchFoods({ query: 'beef AND' }, createMockContext()),
      ).rejects.toMatchObject({ data: { reason: 'query_syntax' } });

      expect(statusCalls(log.debug, 400)).toHaveLength(1);
      expect(statusCalls(log.error, 400)).toHaveLength(0);
    });
  });

  /**
   * Every declared caller-input or expected-miss reason sets `severity:
   * 'notice'`, so the tool failure record (`Error in tool:<name>`) for a typo or
   * a miss stays out of the error stream. Only the handler factory writes that
   * record, so the call goes through a worker's `tools/call`.
   */
  describe('tool failure record level', () => {
    const SEARCH_400 = () =>
      http.route({
        method: 'POST',
        match: (request) => new URL(request.url).pathname.endsWith('/foods/search'),
        respond: () => Response.json({ error: 'Bad Request' }, { status: 400 }),
      });
    const SEARCH_EMPTY = () =>
      http.route({
        method: 'POST',
        match: (request) => new URL(request.url).pathname.endsWith('/foods/search'),
        respond: () => Response.json({ totalHits: 0, currentPage: 1, totalPages: 0, foods: [] }),
      });
    /** Serves a single food with no portions; the returned harness overrides the fake until restored. */
    const NO_PORTIONS = () => {
      const harness = createFetchMock([
        {
          method: 'GET',
          match: (request) => new URL(request.url).pathname.includes('/food/'),
          respond: () => Response.json({ ...RAW_KALE, foodPortions: [] }),
        },
      ]);
      harness.install();
      return harness;
    };

    /** Sends one `tools/call` through a worker handler and returns the error reason the client receives. */
    async function workerCallReason(name: string, args: Record<string, unknown>): Promise<unknown> {
      vi.stubEnv('IS_SERVERLESS', undefined);
      vi.stubEnv('MCP_TRANSPORT_TYPE', undefined);
      vi.stubEnv('MCP_LOG_LEVEL', undefined);
      const worker = createWorkerHandler({
        name: 'usda-mcp-server',
        tools: [usdaSearchFoods, usdaGetFood, usdaCompareFoods],
      });
      const response = await worker.fetch(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            'MCP-Protocol-Version': '2026-07-28',
            'Mcp-Method': 'tools/call',
            'Mcp-Name': name,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name,
              arguments: args,
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            },
          }),
        }),
        { LOG_LEVEL: 'debug' },
        { waitUntil: () => {}, passThroughOnException: () => {} } as never,
      );
      const body = (await response.json()) as {
        result?: { structuredContent?: { error?: { data?: { reason?: unknown } } } };
      };
      return body.result?.structuredContent?.error?.data?.reason;
    }

    afterEach(() => vi.restoreAllMocks());

    it.each<[string, string, Record<string, unknown>, (() => { restore(): void } | undefined)?]>([
      ['query_syntax', 'usda_search_foods', { query: 'beef AND' }, SEARCH_400],
      ['query_empty', 'usda_search_foods', { query: '   ' }],
      ['no_results', 'usda_search_foods', { query: 'zzzz' }, SEARCH_EMPTY],
      ['quantity_without_unit', 'usda_get_food', { fdcId: KALE, quantity: 2 }],
      ['not_found', 'usda_get_food', { fdcId: 999_999 }],
      ['no_portion_data', 'usda_get_food', { fdcId: KALE, unit: 'serving' }, NO_PORTIONS],
      ['too_few_foods', 'usda_compare_foods', { fdcIds: [KALE, 999_999] }],
    ])('logs %s from %s at notice, never error', async (reason, name, args, setup) => {
      initFdcService();
      const override = setup?.();
      const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const notice = vi.spyOn(logger, 'notice').mockImplementation(() => {});
      const isFailureRecord = (call: unknown[]) =>
        String(call[0]).startsWith(`Error in tool:${name}`);
      try {
        expect(await workerCallReason(name, args)).toBe(reason);
      } finally {
        override?.restore();
      }

      expect(notice.mock.calls.filter(isFailureRecord)).toHaveLength(1);
      expect(error.mock.calls.filter(isFailureRecord)).toHaveLength(0);
    });
  });

  /**
   * The retry ladder every FDC call runs: 15 s per attempt, up to 3 retries
   * with 1 s / 2 s / 4 s backoff (±25 % jitter), all inside one 45 s budget.
   * Driven on fake timers; each scenario's timings clear the jitter bounds.
   */
  describe('retry ladder', () => {
    const DEADLINE_MS = 45_000;
    const FDC_ORIGIN = 'https://api.nal.usda.gov';
    type Responder = (request: Request) => Response | Promise<Response>;

    /** An upstream that accepted the request and never answers; settles only on abort. */
    const stall: Responder = (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), {
          once: true,
        });
      });

    /** Answers with `response()` after `delayMs`, unless the request aborts first. */
    const after =
      (delayMs: number, response: () => Response): Responder =>
      (request) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(response()), delayMs);
          request.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(request.signal.reason);
            },
            { once: true },
          );
        });

    const status = (code: number, headers?: Record<string, string>) => () =>
      Response.json({ error: 'upstream' }, { status: code, ...(headers && { headers }) });

    let upstream: FetchMockHarness | undefined;
    /** Fake-clock instant each upstream request started at, in call order. */
    let startedAt: number[];

    /**
     * Serves every FDC request from `responders` in order, repeating the last
     * one once the list runs out.
     */
    function serve(...responders: Responder[]): FetchMockHarness {
      let next = 0;
      upstream = createFetchMock([
        {
          match: (request) => {
            const url = new URL(request.url);
            return url.origin === FDC_ORIGIN && url.pathname.startsWith('/fdc/v1/');
          },
          respond: (request) => {
            startedAt.push(Date.now());
            const responder = responders[Math.min(next++, responders.length - 1)];
            if (!responder) throw new Error('serve() needs at least one responder');
            return responder(request);
          },
        },
      ]);
      upstream.install();
      return upstream;
    }

    /** Observes a promise without awaiting it, so the fake clock can be stepped past it. */
    function track<T>(promise: Promise<T>) {
      const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
      promise.then(
        (value) => {
          state.settled = true;
          state.value = value;
        },
        (error: unknown) => {
          state.settled = true;
          state.error = error;
        },
      );
      return state;
    }

    beforeEach(() => {
      vi.useFakeTimers();
      startedAt = [];
    });

    afterEach(() => {
      upstream?.restore();
      upstream = undefined;
      vi.useRealTimers();
    });

    describe('status classification', () => {
      it('retries a 429 to exhaustion and surfaces it as RateLimited', async () => {
        const http = serve(status(429));
        const call = track(service.getFoodDetail(KALE, undefined, createMockContext()));

        await vi.advanceTimersByTimeAsync(20_000);

        expect(call.error).toMatchObject({
          code: JsonRpcErrorCode.RateLimited,
          data: { status: 429, retryAttempts: 4 },
        });
        expect(http.calls).toHaveLength(4);
      });

      it('retries a 503 to exhaustion and surfaces it as ServiceUnavailable', async () => {
        const http = serve(status(503));
        const call = track(service.getFoodDetail(KALE, undefined, createMockContext()));

        await vi.advanceTimersByTimeAsync(20_000);

        expect(call.error).toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { status: 503, retryAttempts: 4 },
        });
        expect(http.calls).toHaveLength(4);
      });

      it.each([
        [400, JsonRpcErrorCode.InvalidParams],
        [404, JsonRpcErrorCode.NotFound],
      ])('fails a %i at once without retrying', async (code, expected) => {
        const http = serve(status(code));
        const call = track(service.getFoodDetail(KALE, undefined, createMockContext()));

        await vi.advanceTimersByTimeAsync(20_000);

        expect(call.error).toMatchObject({ code: expected, data: { status: code } });
        expect(http.calls).toHaveLength(1);
      });

      it('returns the result when a transient failure is followed by a success', async () => {
        const http = serve(status(503), () => Response.json(RAW_KALE));
        const call = track(service.getFoodDetail(KALE, undefined, createMockContext()));

        await vi.advanceTimersByTimeAsync(2_000);

        expect(call.error).toBeUndefined();
        expect(call.value?.description).toBe('Kale, raw');
        expect(http.calls).toHaveLength(2);
      });
    });

    describe('total deadline', () => {
      it('rejects a stalled upstream at 45 s with retry_deadline_exceeded', async () => {
        const http = serve(stall);
        const start = Date.now();
        const call = track(service.getFoodDetail(KALE, undefined, createMockContext()));

        await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
        expect(call.settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(call.settled).toBe(true);

        // Two attempts time out at 15 s each; the deadline cuts the third.
        expect(call.error).toMatchObject({
          code: JsonRpcErrorCode.Timeout,
          data: { reason: 'retry_deadline_exceeded', deadlineMs: DEADLINE_MS, retryAttempts: 3 },
        });

        await vi.advanceTimersByTimeAsync(60_000);
        expect(http.calls).toHaveLength(3);
        expect(Math.max(...startedAt) - start).toBeLessThan(DEADLINE_MS);
      });

      it('fails at once with the RateLimited error when Retry-After outlasts the budget', async () => {
        // Attempt 1 times out at 15 s; attempt 2 starts by 16.25 s and is told to
        // wait 30 s — inside maxDelayMs, past the ~29 s of budget left.
        const http = serve(stall, status(429, { 'Retry-After': '30' }));
        const call = track(service.getFoodDetail(KALE, undefined, createMockContext()));

        await vi.advanceTimersByTimeAsync(16_500);

        expect(call.settled).toBe(true);
        expect(call.error).toMatchObject({
          code: JsonRpcErrorCode.RateLimited,
          data: { status: 429, retryAfter: '30' },
        });
        expect(http.calls).toHaveLength(2);
      });

      it('keeps the last 429 rather than reporting an outage when slow 429s use up the budget', async () => {
        // Each 429 takes 14.5 s to arrive, so the deadline cuts attempt 3 mid-flight.
        const http = serve(after(14_500, status(429)));
        const call = track(service.getFoodDetail(KALE, undefined, createMockContext()));

        await vi.advanceTimersByTimeAsync(DEADLINE_MS);

        expect(call.settled).toBe(true);
        expect(call.error).toMatchObject({
          code: JsonRpcErrorCode.RateLimited,
          data: { status: 429 },
        });
        expect(http.calls).toHaveLength(3);
      });

      it('reports the deadline, not an earlier 429, when the later attempts stalled', async () => {
        // A fast 429, then three attempts that each run out their own 15 s timeout or the budget.
        const http = serve(status(429), stall);
        const call = track(service.getFoodDetail(KALE, undefined, createMockContext()));

        await vi.advanceTimersByTimeAsync(DEADLINE_MS);

        expect(call.settled).toBe(true);
        expect(call.error).toMatchObject({
          code: JsonRpcErrorCode.Timeout,
          data: { reason: 'retry_deadline_exceeded' },
        });
        expect(http.calls).toHaveLength(4);
      });
    });

    describe('caller cancellation', () => {
      it('settles as RequestCancelled when the caller aborts mid-attempt', async () => {
        const http = serve(stall);
        const controller = new AbortController();
        const call = track(
          service.getFoodDetail(KALE, undefined, createMockContext({ signal: controller.signal })),
        );

        await vi.advanceTimersByTimeAsync(5_000);
        controller.abort();
        await vi.advanceTimersByTimeAsync(120_000);

        expect(call.error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
        expect(http.calls).toHaveLength(1);
      });

      it('starts no further attempt when the caller aborts during a backoff', async () => {
        const http = serve(status(503));
        const controller = new AbortController();
        const call = track(
          service.getFoodDetail(KALE, undefined, createMockContext({ signal: controller.signal })),
        );

        // Attempt 1 fails at once; its backoff lasts at least 750 ms.
        await vi.advanceTimersByTimeAsync(500);
        expect(http.calls).toHaveLength(1);
        controller.abort();
        await vi.advanceTimersByTimeAsync(120_000);

        // withRetry rejects with the signal's own reason; the handler factory
        // reports it as RequestCancelled because the request signal fired.
        expect(call.error).toMatchObject({ name: 'AbortError' });
        expect(http.calls).toHaveLength(1);
      });

      it('reaches the caller as RequestCancelled through the tool boundary', async () => {
        initFdcService();
        const http = serve(status(503));
        const controller = new AbortController();
        const call = track(
          runToolContract(
            usdaSearchFoods,
            { query: 'kale' },
            { context: { signal: controller.signal } },
          ),
        );

        await vi.advanceTimersByTimeAsync(500);
        controller.abort('caller went away');
        await vi.advanceTimersByTimeAsync(120_000);

        // The message is the signal's own reason, so a service that wrapped the cancellation would show here.
        expect(call.value?.structuredContent).toEqual({
          error: { code: JsonRpcErrorCode.RequestCancelled, message: 'caller went away' },
        });
        expect(firstText(call.value?.content ?? [])).toBe('Error: caller went away');
        expect(http.calls).toHaveLength(1);
      });
    });
  });
});
