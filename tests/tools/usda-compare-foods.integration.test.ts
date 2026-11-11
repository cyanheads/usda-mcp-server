/**
 * @fileoverview usda_compare_foods driven through the real FdcService against a
 * stand-in FoodData Central API. The sibling suite mocks the service and feeds
 * it pre-filtered fixtures, so it cannot see whether the nutrient filter the
 * tool sends actually resolves upstream — this one can.
 * @module tests/tools/usda-compare-foods.integration.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usdaCompareFoods } from '@/mcp-server/tools/definitions/usda-compare-foods.tool.js';
import { initFdcService } from '@/services/fdc/fdc-service.js';
import {
  createFdcFake,
  RAW_APPLE_JUICE,
  RAW_BROCCOLI,
  RAW_BROCCOLI_SR,
  RAW_CEREAL,
  RAW_COOKIE,
  RAW_FLOUR,
  RAW_OLIVE_OIL,
  RAW_OLIVE_OIL_SR,
  RAW_POLLOCK,
} from '../fdc-fake.js';
import { firstText } from '../helpers.js';

const { format } = usdaCompareFoods;
if (!format) throw new Error('usda_compare_foods must declare format()');

const KALE = 168421;
const SPINACH = 168462;
const ENERGY = 1008;
const PROTEIN = 1003;
const FAT = 1004;
const IRON = 1089;
/** Total Sugars — the sugars id in the tool's 12 defaults, present in both foods. */
const TOTAL_SUGARS = 2000;
/** Sugars, Total — a real but Foundation-only id, absent from both foods in FDC. */
const FOUNDATION_SUGARS = 1063;

let http: ReturnType<typeof createFdcFake>;

describe('usdaCompareFoods over the real FdcService', () => {
  beforeEach(() => {
    vi.stubEnv('USDA_FDC_API_KEY', 'test-key');
    http = createFdcFake();
    http.install();
    initFdcService();
  });

  afterEach(() => {
    http.restore();
    vi.unstubAllEnvs();
  });

  it('populates the default 12-nutrient comparison', async () => {
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const input = usdaCompareFoods.input.parse({ fdcIds: [KALE, SPINACH] });
    const result = await usdaCompareFoods.handler(input, ctx);

    // All 12 defaults resolve against both foods.
    expect(result.nutrients).toHaveLength(12);
    expect(result.nutrients.every((row) => row.values.every((v) => v !== null))).toBe(true);

    const iron = result.nutrients.find((row) => row.id === IRON);
    expect(iron).toEqual({ id: IRON, name: 'Iron, Fe', unit: 'mg', values: [1.6, 2.71] });

    const sugars = result.nutrients.find((row) => row.id === TOTAL_SUGARS);
    expect(sugars).toEqual({
      id: TOTAL_SUGARS,
      name: 'Total Sugars',
      unit: 'g',
      values: [0.99, 0.42],
    });
  });

  it('reports nothing missing when every default resolves', async () => {
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const input = usdaCompareFoods.input.parse({ fdcIds: [KALE, SPINACH] });
    const result = await usdaCompareFoods.handler(input, ctx);

    expect(result.missingData).toBeUndefined();
  });

  it('reports a genuinely absent nutrient as missing rather than filtered out', async () => {
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const input = usdaCompareFoods.input.parse({
      fdcIds: [KALE, SPINACH],
      nutrients: [PROTEIN, FOUNDATION_SUGARS],
    });
    const result = await usdaCompareFoods.handler(input, ctx);

    expect(result.nutrients.map((row) => row.id)).toEqual([PROTEIN]);
    expect(result.missingData).toEqual([
      { fdcId: KALE, nutrientId: FOUNDATION_SUGARS },
      { fdcId: SPINACH, nutrientId: FOUNDATION_SUGARS },
    ]);
  });

  it('renders the pivot table with values in the content text', async () => {
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const input = usdaCompareFoods.input.parse({ fdcIds: [KALE, SPINACH] });
    const text = firstText(format(await usdaCompareFoods.handler(input, ctx)));

    expect(text).toContain('| Iron, Fe (mg) [ID:1089] | 1.6 | 2.71 |');
    expect(text).toContain('| Protein (g) [ID:1003] | 2.92 | 2.86 |');
    // A table whose every cell is an em dash is the empty-comparison symptom.
    expect(text).not.toContain('| — | — |');
  });

  it('honors an explicit nutrient filter on both consumption paths', async () => {
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const input = usdaCompareFoods.input.parse({
      fdcIds: [KALE, SPINACH],
      nutrients: [PROTEIN, IRON],
    });
    const result = await usdaCompareFoods.handler(input, ctx);

    expect(result.nutrients.map((row) => row.id)).toEqual([PROTEIN, IRON]);
    expect(result.missingData).toBeUndefined();
    expect(firstText(format(result))).toContain('| Iron, Fe (mg) [ID:1089] | 1.6 | 2.71 |');
  });

  it('scales every value to a non-default gram basis', async () => {
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const input = usdaCompareFoods.input.parse({
      fdcIds: [KALE, SPINACH],
      nutrients: [IRON],
      quantity: 50,
      unit: 'g',
    });
    const result = await usdaCompareFoods.handler(input, ctx);

    expect(result.nutrients[0]?.values).toEqual([0.8, 1.355]);
  });

  /** FDC answers HTTP 200 `{}` when it knows none of the requested IDs. */
  it('reaches too_few_foods when no requested ID exists', async () => {
    const result = await runToolContract(usdaCompareFoods, {
      fdcIds: [999_999_998, 999_999_999],
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message: 'Only 0 of 2 FDC IDs returned data.',
        data: { reason: 'too_few_foods' },
      },
    });
    expect(firstText(result.content)).toContain('Only 0 of 2 FDC IDs returned data.');
  });

  it('records no substitutions when both foods report every default directly', async () => {
    const ctx = createMockContext({ errors: usdaCompareFoods.errors });
    const result = await usdaCompareFoods.handler(
      usdaCompareFoods.input.parse({ fdcIds: [KALE, SPINACH] }),
      ctx,
    );

    expect(result).not.toHaveProperty('substitutions');
  });

  describe('default rows over Foundation records', () => {
    const compare = async (args: { fdcIds: number[]; nutrients?: number[]; quantity?: number }) =>
      usdaCompareFoods.handler(
        usdaCompareFoods.input.parse(args),
        createMockContext({ errors: usdaCompareFoods.errors }),
      );

    it('fills Foundation broccoli’s Sugars from 1063', async () => {
      const result = await compare({ fdcIds: [RAW_BROCCOLI.fdcId, RAW_BROCCOLI_SR.fdcId] });

      expect(result.nutrients.find((row) => row.id === TOTAL_SUGARS)).toEqual({
        id: TOTAL_SUGARS,
        name: 'Total Sugars',
        unit: 'g',
        values: [1.4, 1.7],
      });
      expect(result.substitutions).toEqual([
        { fdcId: 747447, requested: TOTAL_SUGARS, used: FOUNDATION_SUGARS },
      ]);
      expect(result.missingData).toBeUndefined();
      const text = firstText(format(result));
      expect(text).toContain('| Nutrient | Broccoli, raw (747447) | Broccoli, raw (170379) |');
      expect(text).toContain('| Total Sugars (g) [ID:2000] | 1.4 | 1.7 |');
      expect(text).toContain('- FDC ID 747447: nutrient 2000 filled from 1063');
    });

    it('fills Energy from 2048 when neither food reports 1008, naming the row from the reference', async () => {
      const result = await compare({ fdcIds: [RAW_FLOUR.fdcId, RAW_APPLE_JUICE.fdcId] });

      expect(result.nutrients.find((row) => row.id === ENERGY)).toEqual({
        id: ENERGY,
        name: 'Energy',
        unit: 'KCAL',
        values: [365.6107, 47.2318],
      });
      expect(result.substitutions).toEqual([
        { fdcId: 2003586, requested: ENERGY, used: 2048 },
        { fdcId: 2003590, requested: ENERGY, used: 2048 },
        { fdcId: 2003590, requested: TOTAL_SUGARS, used: FOUNDATION_SUGARS },
      ]);
      expect(result.missingData).toContainEqual({ fdcId: 2003586, nutrientId: TOTAL_SUGARS });
      expect(result.missingData).not.toContainEqual({ fdcId: 2003586, nutrientId: ENERGY });
    });

    it('fills Energy from 2047 when a food reports only the general-factor estimate', async () => {
      const result = await compare({ fdcIds: [RAW_POLLOCK.fdcId, RAW_BROCCOLI_SR.fdcId] });

      expect(result.nutrients.find((row) => row.id === ENERGY)).toEqual({
        id: ENERGY,
        name: 'Energy',
        unit: 'kcal',
        values: [78.4785, 34],
      });
      expect(result.substitutions).toEqual([{ fdcId: 2768188, requested: ENERGY, used: 2047 }]);
    });

    it('scales filled values with the basis', async () => {
      const result = await compare({
        fdcIds: [RAW_FLOUR.fdcId, RAW_APPLE_JUICE.fdcId],
        quantity: 50,
      });

      expect(result.nutrients.find((row) => row.id === ENERGY)?.values).toEqual([
        182.8054, 23.6159,
      ]);
    });

    it('keeps an explicit nutrients[] literal', async () => {
      const result = await compare({
        fdcIds: [RAW_FLOUR.fdcId, RAW_BROCCOLI_SR.fdcId],
        nutrients: [ENERGY],
      });

      expect(result.nutrients).toEqual([
        { id: ENERGY, name: 'Energy', unit: 'kcal', values: [null, 34] },
      ]);
      expect(result.missingData).toEqual([{ fdcId: 2003586, nutrientId: ENERGY }]);
      expect(result).not.toHaveProperty('substitutions');
    });
  });

  describe('basis of each compared food', () => {
    it('compares a per-100 ml label unchanged and names it in the notice', async () => {
      const result = await runToolContract(usdaCompareFoods, {
        fdcIds: [RAW_OLIVE_OIL.fdcId, RAW_OLIVE_OIL_SR.fdcId],
        nutrients: [ENERGY, FAT],
      });
      const notice =
        'FDC ID 2151571 reports values per 100 ml; its column is per 100 ml, compared without density conversion.';

      expect(result.structuredContent).toMatchObject({
        foods: [
          { fdcId: 2151571, basisUnit: 'ml', servingSizeUnit: 'ml' },
          { fdcId: 171413, basisUnit: 'g' },
        ],
        nutrients: [
          { id: ENERGY, values: [800, 884] },
          { id: FAT, values: [93.33, 100] },
        ],
        notice,
      });
      const text = result.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      expect(text).toContain(`> ${notice}`);
      expect(text).toContain(
        '- **EXTRA VIRGIN OLIVE OIL, EXTRA VIRGIN** (FDC ID: 2151571, type: Branded, label unit: ml, basis: per 100 ml)',
      );
    });

    it('adds no notice for a per-100 g label beside an SR Legacy food', async () => {
      const result = await runToolContract(usdaCompareFoods, {
        fdcIds: [RAW_OLIVE_OIL_SR.fdcId, RAW_CEREAL.fdcId],
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        foods: [{ basisUnit: 'g' }, { basisUnit: 'g', servingSizeUnit: 'GRM' }],
      });
      expect(result.structuredContent).not.toHaveProperty('notice');
    });

    it('names a label unit that leaves the basis unverified', async () => {
      const result = await runToolContract(usdaCompareFoods, {
        fdcIds: [RAW_COOKIE.fdcId, RAW_OLIVE_OIL_SR.fdcId],
        nutrients: [ENERGY],
      });

      expect(result.structuredContent).toMatchObject({
        notice: 'FDC ID 2538887 has an unverified per-100 basis (label unit IU).',
      });
      const food = (result.structuredContent as { foods: object[] }).foods[0] ?? {};
      expect(Object.hasOwn(food, 'basisUnit')).toBe(false);
    });
  });
});
