/**
 * @fileoverview Tests for usda_get_foods (batch) tool.
 * @module tests/tools/usda-get-foods.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usdaGetFoods } from '@/mcp-server/tools/definitions/usda-get-foods.tool.js';
import { createFdcFake, RAW_COOKIE, RAW_MILK } from '../fdc-fake.js';
import { allText, firstText } from '../helpers.js';

const { format } = usdaGetFoods;
if (!format) throw new Error('usda_get_foods must declare format()');

/** The `usda.batch.deferrals` counter the tool creates at module scope, and the arguments of each creation. */
const deferrals = vi.hoisted(() => ({ add: vi.fn(), created: [] as unknown[][] }));

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  /**
   * Creation is recorded outside the mock's call history: Vitest clears that
   * history before every test (`clearMocks` defaults on), which erases a call
   * made while the module loaded.
   */
  createCounter: vi.fn((...args: unknown[]) => {
    deferrals.created.push(args);
    return deferrals;
  }),
}));

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

/** `count` distinct positive FDC ids, starting at `from` — the values are irrelevant, the length is not. */
const ids = (count: number, from = 1) => Array.from({ length: count }, (_v, i) => i + from);

/** A food the mocked service returns for each id it was asked for, so a call's fetched set is visible. */
const foodFor = (fdcId: number) => ({
  fdcId,
  description: `Food ${fdcId}`,
  dataType: 'SR Legacy',
  basisUnit: 'g' as const,
  nutrients: [],
  portions: [],
});

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

  describe('batch size boundaries', () => {
    /**
     * The declared window is 2–500 entries; 20 is the batch size, so anything
     * past it is deferred rather than rejected, and one past either edge of the
     * window must not reach the API.
     */
    it('accepts the smallest and largest declared batch', () => {
      expect(usdaGetFoods.input.parse({ fdcIds: [1, 2] }).fdcIds).toHaveLength(2);
      expect(usdaGetFoods.input.parse({ fdcIds: ids(20) }).fdcIds).toHaveLength(20);
      expect(usdaGetFoods.input.parse({ fdcIds: ids(500) }).fdcIds).toHaveLength(500);
    });

    it('rejects a single id — usda_get_food covers that case', () => {
      expect(() => usdaGetFoods.input.parse({ fdcIds: [171077] })).toThrow();
    });

    it('accepts one past the batch size, deferring the rest instead of rejecting the call', () => {
      expect(usdaGetFoods.input.parse({ fdcIds: ids(21) }).fdcIds).toHaveLength(21);
    });

    it('rejects one past the 500-entry window', async () => {
      const result = await runToolContract(usdaGetFoods, { fdcIds: ids(501) });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(firstText(result.content)).toContain('Too big: expected array to have <=500 items');
    });

    it('advertises the 500-entry window', () => {
      const schema = z.toJSONSchema(usdaGetFoods.input);
      expect(schema.properties?.fdcIds).toMatchObject({ minItems: 2, maxItems: 500 });
    });
  });

  it('reports an all-missing batch as empty on both consumption paths', async () => {
    const service = await getServiceMock();
    const failed = [
      { fdcId: 999_998, error: 'FDC ID 999998 not found or returned no data.' },
      { fdcId: 999_999, error: 'FDC ID 999999 not found or returned no data.' },
    ];
    service.getFoodsBatch.mockResolvedValue({ foods: [], failed });
    const ctx = createMockContext();
    const input = usdaGetFoods.input.parse({ fdcIds: [999_998, 999_999] });
    const result = await usdaGetFoods.handler(input, ctx);

    // structuredContent path
    expect(result.foods).toHaveLength(0);
    expect(result.failed).toEqual(failed);

    // content[] path — an empty batch must say so rather than render nothing
    const text = firstText(format(result));
    expect(text).toContain('0 foods fetched');
    expect(text).toContain('2 failed');
    expect(text).toContain('999998');
    expect(text).toContain('999999');
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

  it('escapes Markdown syntax in FDC-supplied text so content[] reads back as written', () => {
    const output = {
      foods: [
        {
          fdcId: 999,
          description: 'Crunchy *Star* Bars [Organic] | <b>new</b>',
          dataType: 'Branded',
          nutrients: [
            { id: 1004, name: 'Fat *total* [lipid] | <b>', number: '204', amount: 3, unit: 'g' },
          ],
        },
      ],
      failed: [{ fdcId: 1, error: 'FDC ID 1 *not* found [batch] | <b>' }],
    };
    const text = firstText(format(output));
    expect(text).toContain('### Crunchy \\*Star\\* Bars \\[Organic\\] \\| \\<b>new\\</b>');
    expect(text).toContain('- Fat \\*total\\* \\[lipid\\] \\| \\<b> (ID: 1004, SR#: 204): 3 g');
    expect(text).toContain('- FDC ID 1: FDC ID 1 \\*not\\* found \\[batch\\] \\| \\<b>');
  });
});

describe('usdaGetFoods batch size and deferredIds', () => {
  beforeEach(async () => {
    deferrals.add.mockClear();
    const service = await getServiceMock();
    service.getFoodsBatch.mockReset();
    service.getFoodsBatch.mockImplementation(async (fdcIds: number[]) => ({
      foods: fdcIds.map(foodFor),
      failed: [],
    }));
  });

  it('creates its deferral counter as usda.batch.deferrals, counted in {calls}', () => {
    expect(deferrals.created).toContainEqual([
      'usda.batch.deferrals',
      expect.any(String),
      '{calls}',
    ]);
  });

  it.each([2, 20])(
    'leaves %i distinct IDs alone: one fetch, no deferredIds, notice, log line, or count',
    async (count) => {
      const service = await getServiceMock();
      const ctx = createMockContext();
      const result = await usdaGetFoods.handler(
        usdaGetFoods.input.parse({ fdcIds: ids(count) }),
        ctx,
      );

      expect(service.getFoodsBatch).toHaveBeenCalledExactlyOnceWith(ids(count), undefined, ctx);
      expect(result.foods.map((f) => f.fdcId)).toEqual(ids(count));
      expect(Object.hasOwn(result, 'deferredIds')).toBe(false);
      expect((ctx.log as MockContextLogger).calls.filter((c) => c.level === 'notice')).toEqual([]);
      expect(deferrals.add).not.toHaveBeenCalled();

      const contract = await runToolContract(usdaGetFoods, { fdcIds: ids(count) });
      expect(contract.structuredContent).not.toHaveProperty('notice');
      expect(contract.structuredContent).not.toHaveProperty('deferredIds');
    },
  );

  it('fetches the first 20 of 21 distinct IDs and defers the 21st', async () => {
    const service = await getServiceMock();
    const ctx = createMockContext();
    const result = await usdaGetFoods.handler(usdaGetFoods.input.parse({ fdcIds: ids(21) }), ctx);

    expect(service.getFoodsBatch).toHaveBeenCalledExactlyOnceWith(ids(20), undefined, ctx);
    expect(result.foods.map((f) => f.fdcId)).toEqual(ids(20));
    expect(result.failed).toEqual([]);
    expect(result.deferredIds).toEqual([21]);
  });

  it('keeps failed[] to the fetched IDs', async () => {
    const service = await getServiceMock();
    service.getFoodsBatch.mockImplementation(async (fdcIds: number[]) => ({
      foods: [],
      failed: fdcIds.map((fdcId) => ({ fdcId, error: `FDC ID ${fdcId} not found.` })),
    }));
    const result = await usdaGetFoods.handler(
      usdaGetFoods.input.parse({ fdcIds: ids(22) }),
      createMockContext(),
    );

    expect(result.failed.map((f) => f.fdcId)).toEqual(ids(20));
    expect(result.deferredIds).toEqual([21, 22]);
  });

  it('logs one notice with the counts and adds 1 to the deferral counter', async () => {
    const ctx = createMockContext();
    await usdaGetFoods.handler(usdaGetFoods.input.parse({ fdcIds: [7, 7, ...ids(20, 100)] }), ctx);

    const notices = (ctx.log as MockContextLogger).calls.filter((c) => c.level === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.data).toMatchObject({
      requested: 22,
      distinct: 21,
      fetched: 20,
      deferred: 1,
    });
    expect(deferrals.add).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('discloses the deferral on both surfaces', async () => {
    const result = await runToolContract(usdaGetFoods, { fdcIds: ids(25) });
    const notice =
      'Fetched the first 20 of 25 distinct FDC IDs; call usda_get_foods again with the 5 IDs in deferredIds.';

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ deferredIds: [21, 22, 23, 24, 25], notice });
    const text = allText(result.content);
    expect(text).toContain(`> ${notice}`);
    expect(text).toContain('**Deferred (not fetched):** 21, 22, 23, 24, 25');
  });

  /** usda_get_foods takes at least 2 IDs, so one deferred ID is a usda_get_food call. */
  it('routes a single deferred ID to usda_get_food with its value', async () => {
    const result = await runToolContract(usdaGetFoods, { fdcIds: ids(21) });

    expect(result.structuredContent).toMatchObject({
      deferredIds: [21],
      notice:
        'Fetched the first 20 of 21 distinct FDC IDs; fetch the 1 ID in deferredIds with usda_get_food (fdcId 21).',
    });
  });

  it('drops repeats before splitting, keeping first occurrences in request order', async () => {
    const service = await getServiceMock();
    const ctx = createMockContext();
    // 25 entries holding 20 distinct IDs
    const fdcIds = [3, ...ids(20), 5, 1, 20, 3];
    const result = await usdaGetFoods.handler(usdaGetFoods.input.parse({ fdcIds }), ctx);

    expect(service.getFoodsBatch).toHaveBeenCalledExactlyOnceWith(
      [3, 1, 2, ...ids(17, 4)],
      undefined,
      ctx,
    );
    expect(result.foods).toHaveLength(20);
    expect(Object.hasOwn(result, 'deferredIds')).toBe(false);
    expect(deferrals.add).not.toHaveBeenCalled();
  });

  it('sends one occurrence of a repeated ID', async () => {
    const service = await getServiceMock();
    const ctx = createMockContext();
    const result = await usdaGetFoods.handler(
      usdaGetFoods.input.parse({ fdcIds: [171077, 171077] }),
      ctx,
    );

    expect(service.getFoodsBatch).toHaveBeenCalledExactlyOnceWith([171077], undefined, ctx);
    expect(result.foods.map((f) => f.fdcId)).toEqual([171077]);
  });
});

describe('usdaGetFoods basis and missingNutrients', () => {
  /** The output keys the handler builds from a service food, rendered through the real pipeline. */
  const run = async (foods: object[], args: { fdcIds: number[]; nutrients?: number[] }) => {
    const service = await getServiceMock();
    service.getFoodsBatch.mockReset();
    service.getFoodsBatch.mockResolvedValue({
      foods,
      failed: [{ fdcId: 5, error: 'FDC ID 5 not found or returned no data.' }],
    });
    return runToolContract(usdaGetFoods, args);
  };

  it('carries basisUnit and the label unit, and names the basis in content[]', async () => {
    const result = await run(
      [
        { ...foodFor(2078244), dataType: 'Branded', basisUnit: 'ml', servingSizeUnit: 'ml' },
        { ...foodFor(168421) },
        { ...foodFor(2538887), dataType: 'Branded', basisUnit: undefined, servingSizeUnit: 'IU' },
      ],
      { fdcIds: [2078244, 168421, 2538887, 5] },
    );
    const foods = (result.structuredContent as { foods: Array<Record<string, unknown>> }).foods;

    expect(foods.map((f) => [f.fdcId, f.basisUnit, f.servingSizeUnit])).toEqual([
      [2078244, 'ml', 'ml'],
      [168421, 'g', undefined],
      [2538887, undefined, 'IU'],
    ]);
    expect(Object.hasOwn(foods[2] ?? {}, 'basisUnit')).toBe(false);
    const text = allText(result.content);
    expect(text).toContain('**Nutrients (per 100 ml):**');
    expect(text).toContain('**Nutrients (per 100g):**');
    expect(text).toContain('**Nutrients (per 100 IU label units (basis unverified)):**');
    expect(text).toContain('**FDC ID:** 2078244 | **Type:** Branded | **Label unit:** ml');
  });

  it('names the basis even when a food returns no nutrients', async () => {
    const text = allText(
      (
        await run([{ ...foodFor(2538887), dataType: 'Branded', basisUnit: undefined }], {
          fdcIds: [2538887, 5],
        })
      ).content,
    );

    expect(text).toContain(
      '**Nutrients (per 100 label units (basis unverified, no label unit)):** none returned for this food.',
    );
  });

  it('escapes a Markdown-active label unit in content[] only', async () => {
    const result = await run(
      [{ ...foodFor(1), dataType: 'Branded', basisUnit: undefined, servingSizeUnit: '*IU*' }],
      { fdcIds: [1, 5] },
    );

    expect(result.structuredContent).toMatchObject({ foods: [{ servingSizeUnit: '*IU*' }] });
    const text = allText(result.content);
    expect(text).toContain('**Label unit:** \\*IU\\*');
    expect(text).toContain('per 100 \\*IU\\* label units (basis unverified)');
  });

  it('carries each food’s missingNutrients on both surfaces, never on failed[]', async () => {
    const result = await run(
      [
        { ...foodFor(2003586), missingNutrients: [99999] },
        { ...foodFor(170379), missingNutrients: [1008, 99999] },
      ],
      { fdcIds: [2003586, 170379, 5], nutrients: [1008, 99999] },
    );
    const content = result.structuredContent as {
      foods: Array<{ missingNutrients?: number[] }>;
      failed: object[];
    };

    expect(content.foods.map((f) => f.missingNutrients)).toEqual([[99999], [1008, 99999]]);
    expect(content.failed).toEqual([
      { fdcId: 5, error: 'FDC ID 5 not found or returned no data.' },
    ]);
    const text = allText(result.content);
    expect(text).toContain('**Missing nutrients:** 99999\n');
    expect(text).toContain('**Missing nutrients:** 1008, 99999');
  });

  it('omits missingNutrients when the service reports none', async () => {
    const result = await run([foodFor(168421)], { fdcIds: [168421, 5], nutrients: [1008] });
    const food = (result.structuredContent as { foods: object[] }).foods[0] ?? {};

    expect(Object.hasOwn(food, 'missingNutrients')).toBe(false);
    expect(allText(result.content)).not.toContain('Missing nutrients');
  });
});

describe('usdaGetFoods over the real FdcService', () => {
  let http: ReturnType<typeof createFdcFake>;

  beforeEach(async () => {
    vi.stubEnv('USDA_FDC_API_KEY', 'test-key');
    http = createFdcFake();
    http.install();
    const actual = await vi.importActual<typeof import('@/services/fdc/fdc-service.js')>(
      '@/services/fdc/fdc-service.js',
    );
    const real = new actual.FdcService();
    const service = await getServiceMock();
    service.getFoodsBatch.mockReset();
    service.getFoodsBatch.mockImplementation((...args: Parameters<typeof real.getFoodsBatch>) =>
      real.getFoodsBatch(...args),
    );
  });

  afterEach(() => {
    http.restore();
    vi.unstubAllEnvs();
  });

  /** FDC answers HTTP 200 `{}` when it knows none of the IDs; the batch is still a success. */
  it('answers all-unknown IDs with empty foods and both IDs in failed', async () => {
    const result = await runToolContract(usdaGetFoods, { fdcIds: [999_999_998, 999_999_999] });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      foods: [],
      failed: [
        { fdcId: 999_999_998, error: 'FDC ID 999999998 not found or returned no data.' },
        { fdcId: 999_999_999, error: 'FDC ID 999999999 not found or returned no data.' },
      ],
    });
    const text = allText(result.content);
    expect(text).toContain('**0 foods fetched** | **2 failed**');
    expect(text).toContain('- FDC ID 999999998: FDC ID 999999998 not found or returned no data.');
  });

  it('keeps a mixed batch as it was', async () => {
    const result = await runToolContract(usdaGetFoods, {
      fdcIds: [999_999_998, 168421],
      nutrients: [1003],
    });

    expect(result.structuredContent).toMatchObject({
      foods: [{ fdcId: 168421, nutrients: [{ id: 1003, amount: 2.92 }] }],
      failed: [{ fdcId: 999_999_998, error: 'FDC ID 999999998 not found or returned no data.' }],
    });
  });

  it('reports each entry’s basis from its record', async () => {
    const result = await runToolContract(usdaGetFoods, {
      fdcIds: [RAW_MILK.fdcId, 168421, RAW_COOKIE.fdcId],
      nutrients: [1008],
    });
    const foods = (result.structuredContent as { foods: Array<Record<string, unknown>> }).foods;

    expect(foods.map((f) => [f.fdcId, f.basisUnit, f.servingSizeUnit])).toEqual([
      [2078244, 'ml', 'ml'],
      [168421, 'g', undefined],
      [2538887, undefined, 'IU'],
    ]);
    const text = allText(result.content);
    expect(text).toContain(
      '### MILK\n**FDC ID:** 2078244 | **Type:** Branded | **Label unit:** ml\n**Nutrients (per 100 ml):**\n- Energy (ID: 1008, SR#: 208): 62 kcal',
    );
    expect(text).toContain('**Nutrients (per 100 IU label units (basis unverified)):**');
  });

  it('lists a requested ID a food does not report under that food', async () => {
    const result = await runToolContract(usdaGetFoods, {
      fdcIds: [2003586, 170379],
      nutrients: [99999],
    });

    expect(result.structuredContent).toMatchObject({
      foods: [
        { fdcId: 2003586, nutrients: [], missingNutrients: [99999] },
        { fdcId: 170379, nutrients: [], missingNutrients: [99999] },
      ],
      failed: [],
    });
  });

  it('keeps reported IDs out of missingNutrients, and omits it without a filter', async () => {
    const filtered = await runToolContract(usdaGetFoods, {
      fdcIds: [170379, 168421],
      nutrients: [1008, 99999, 2000],
    });
    const unfiltered = await runToolContract(usdaGetFoods, { fdcIds: [170379, 168421] });
    type Foods = { foods: Array<{ nutrients: object[]; missingNutrients?: number[] }> };

    for (const food of (filtered.structuredContent as Foods).foods) {
      expect(food.nutrients).toHaveLength(2);
      expect(food.missingNutrients).toEqual([99999]);
    }
    for (const food of (unfiltered.structuredContent as Foods).foods) {
      expect(Object.hasOwn(food, 'missingNutrients')).toBe(false);
    }
  });

  it('sends a repeated ID upstream once and returns its food once', async () => {
    const result = await runToolContract(usdaGetFoods, { fdcIds: [168421, 168421] });

    expect(result.structuredContent).toMatchObject({ foods: [{ fdcId: 168421 }], failed: [] });
    expect((result.structuredContent as { foods: object[] }).foods).toHaveLength(1);
    expect(await http.calls[0]?.request.clone().json()).toEqual({ fdcIds: [168421] });
  });
});

describe('USDA_CLAMP_LIMITS', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** A fresh copy of the tool, so its config reads the stubbed variable. */
  async function loadWith(value: string) {
    vi.stubEnv('USDA_CLAMP_LIMITS', value);
    vi.resetModules();
    return (await import('@/mcp-server/tools/definitions/usda-get-foods.tool.js')).usdaGetFoods;
  }

  it('false rejects 21 entries as invalid_arguments, with the same message as the 20-entry bound', async () => {
    const strict = await loadWith('false');
    const result = await runToolContract(strict, { fdcIds: ids(21) });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(firstText(result.content)).toContain(
      'fdcIds: Too big: expected array to have <=20 items',
    );
  });

  it('false still accepts 20 entries and rejects 501 naming the 20-entry bound', async () => {
    const strict = await loadWith('false');

    expect(strict.input.parse({ fdcIds: ids(20) }).fdcIds).toHaveLength(20);
    expect(
      strict.input.safeParse({ fdcIds: ids(501) }).error?.issues.map((i) => i.message),
    ).toEqual(['Too big: expected array to have <=20 items']);
    const text = firstText((await runToolContract(strict, { fdcIds: ids(501) })).content);
    expect(text).toContain('fdcIds: Too big: expected array to have <=20 items');
    expect(text).not.toContain('<=500');
  });

  it('false still advertises the 500-entry window', async () => {
    const strict = await loadWith('false');

    expect(z.toJSONSchema(strict.input).properties?.fdcIds).toMatchObject({ maxItems: 500 });
  });

  it('true accepts 21 entries, like an unset variable', async () => {
    expect((await loadWith('true')).input.safeParse({ fdcIds: ids(21) }).success).toBe(true);
    expect((await loadWith('')).input.safeParse({ fdcIds: ids(21) }).success).toBe(true);
  });

  it.each(['true', ''])('%j keeps the 500-entry message for 501 entries', async (value) => {
    const tool = await loadWith(value);

    expect(tool.input.safeParse({ fdcIds: ids(501) }).error?.issues.map((i) => i.message)).toEqual([
      'Too big: expected array to have <=500 items',
    ]);
  });

  it('a non-boolean value fails config parsing, naming the variable', async () => {
    vi.stubEnv('USDA_CLAMP_LIMITS', 'maybe');
    vi.resetModules();
    const { getLimitsConfig } = await import('@/config/server-config.js');

    expect(() => getLimitsConfig()).toThrow(
      expect.objectContaining({
        code: JsonRpcErrorCode.ConfigurationError,
        message: expect.stringContaining('USDA_CLAMP_LIMITS'),
      }),
    );
  });

  it('reads without USDA_FDC_API_KEY, which only FDC calls need', async () => {
    vi.stubEnv('USDA_FDC_API_KEY', '');
    vi.stubEnv('USDA_CLAMP_LIMITS', 'false');
    vi.resetModules();
    const { getLimitsConfig } = await import('@/config/server-config.js');

    expect(getLimitsConfig()).toEqual({ clampLimits: false });
  });
});
