/**
 * @fileoverview Tests for usda_list_nutrients tool.
 * @module tests/tools/usda-list-nutrients.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { usdaListNutrients } from '@/mcp-server/tools/definitions/usda-list-nutrients.tool.js';
import { firstText } from '../helpers.js';

const { format } = usdaListNutrients;
if (!format) throw new Error('usda_list_nutrients must declare format()');

/** Every category the input enum accepts — each must resolve to rows. */
const CATEGORIES = [
  'macronutrients',
  'vitamins',
  'minerals',
  'lipids',
  'amino_acids',
  'other',
] as const;

// No service dependency — reads from static NUTRIENT_REFERENCE

describe('usdaListNutrients', () => {
  it('returns all nutrients when no category is specified', async () => {
    const ctx = createMockContext();
    const input = usdaListNutrients.input.parse({});
    const result = await usdaListNutrients.handler(input, ctx);

    expect(result.nutrients.length).toBeGreaterThan(0);
    for (const n of result.nutrients) {
      expect(n).toHaveProperty('id');
      expect(n).toHaveProperty('name');
      expect(n).toHaveProperty('number');
      expect(n).toHaveProperty('unit');
      expect(n).toHaveProperty('category');
    }
  });

  it('filters to macronutrients only', async () => {
    const ctx = createMockContext();
    const input = usdaListNutrients.input.parse({ category: 'macronutrients' });
    const result = await usdaListNutrients.handler(input, ctx);

    expect(result.nutrients.length).toBeGreaterThan(0);
    for (const n of result.nutrients) {
      expect(n.category).toBe('macronutrients');
    }
  });

  it('filters to vitamins only', async () => {
    const ctx = createMockContext();
    const input = usdaListNutrients.input.parse({ category: 'vitamins' });
    const result = await usdaListNutrients.handler(input, ctx);

    expect(result.nutrients.length).toBeGreaterThan(0);
    for (const n of result.nutrients) {
      expect(n.category).toBe('vitamins');
    }
  });

  it('filters to minerals only', async () => {
    const ctx = createMockContext();
    const input = usdaListNutrients.input.parse({ category: 'minerals' });
    const result = await usdaListNutrients.handler(input, ctx);

    expect(result.nutrients.length).toBeGreaterThan(0);
    for (const n of result.nutrients) {
      expect(n.category).toBe('minerals');
    }
  });

  it('has no duplicate nutrient IDs', async () => {
    const ctx = createMockContext();
    const input = usdaListNutrients.input.parse({});
    const result = await usdaListNutrients.handler(input, ctx);

    const ids = result.nutrients.map((n) => n.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('has no duplicate nutrient names', async () => {
    const ctx = createMockContext();
    const input = usdaListNutrients.input.parse({});
    const result = await usdaListNutrients.handler(input, ctx);

    const names = result.nutrients.map((n) => n.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('has no duplicate SR reference numbers', async () => {
    const ctx = createMockContext();
    const input = usdaListNutrients.input.parse({});
    const result = await usdaListNutrients.handler(input, ctx);

    const byNumber = new Map<string, string[]>();
    for (const n of result.nutrients) {
      byNumber.set(n.number, [...(byNumber.get(n.number) ?? []), `${n.id} ${n.name}`]);
    }
    const collisions = [...byNumber].filter(([, rows]) => rows.length > 1);
    expect(collisions).toEqual([]);
  });

  it('uses correct ID for Calcium (1087) not Galactose', async () => {
    const ctx = createMockContext();
    const input = usdaListNutrients.input.parse({});
    const result = await usdaListNutrients.handler(input, ctx);

    const calcium = result.nutrients.find((n) => n.id === 1087);
    expect(calcium?.name).toBe('Calcium, Ca');

    const galactose = result.nutrients.find((n) => n.name === 'Galactose');
    expect(galactose?.id).toBe(1075);
  });

  it('includes well-known nutrient IDs for common categories', async () => {
    const ctx = createMockContext();
    const allInput = usdaListNutrients.input.parse({});
    const result = await usdaListNutrients.handler(allInput, ctx);

    const ids = result.nutrients.map((n) => n.id);
    // Core nutrients expected to be present
    expect(ids).toContain(1008); // Energy
    expect(ids).toContain(1003); // Protein
    expect(ids).toContain(1004); // Total fat
    expect(ids).toContain(1005); // Carbohydrate
  });

  it('carries the FDC ids for Lactose, Maltose, and Lutein + zeaxanthin', async () => {
    const ctx = createMockContext();
    const input = usdaListNutrients.input.parse({});
    const result = await usdaListNutrients.handler(input, ctx);
    const byName = new Map(result.nutrients.map((n) => [n.name, n]));

    expect(byName.get('Lactose')).toMatchObject({ id: 1013, number: '213', unit: 'G' });
    expect(byName.get('Maltose')).toMatchObject({ id: 1014, number: '214', unit: 'G' });
    expect(byName.get('Lutein + zeaxanthin')).toMatchObject({
      id: 1123,
      number: '338',
      unit: 'UG',
    });
  });

  it('renders the restored rows in the text content block', async () => {
    const ctx = createMockContext();
    const input = usdaListNutrients.input.parse({});
    const result = await usdaListNutrients.handler(input, ctx);
    const text = firstText(format(result));

    expect(text).toContain('**Lactose** (ID: 1013)');
    expect(text).toContain('**Maltose** (ID: 1014)');
    expect(text).toContain('**Lutein + zeaxanthin** (ID: 1123)');
  });

  it('rejects an unknown category', () => {
    expect(() => usdaListNutrients.input.parse({ category: 'phytonutrients' })).toThrow();
  });

  it('scopes each category to its own rows and covers the whole table', async () => {
    const ctx = createMockContext();
    const all = await usdaListNutrients.handler(usdaListNutrients.input.parse({}), ctx);

    let scopedTotal = 0;
    for (const category of CATEGORIES) {
      const scoped = await usdaListNutrients.handler(
        usdaListNutrients.input.parse({ category }),
        ctx,
      );
      // A category that went empty is a table defect, not a valid filter result.
      expect(scoped.nutrients.length).toBeGreaterThan(0);
      expect(scoped.nutrients.filter((n) => n.category !== category)).toEqual([]);
      scopedTotal += scoped.nutrients.length;
    }
    expect(scopedTotal).toBe(all.nutrients.length);
  });

  it('formats a zero-row result without inventing rows', () => {
    const text = firstText(format({ nutrients: [] }));

    expect(text).toContain('0 nutrients');
    expect(text).not.toContain('(ID:');
  });

  it('formats output with count and nutrient rows including IDs', () => {
    const output = {
      nutrients: [
        { id: 1003, name: 'Protein', number: '203', unit: 'G', category: 'macronutrients' },
        { id: 1162, name: 'Vitamin C', number: '401', unit: 'MG', category: 'vitamins' },
      ],
    };
    const text = firstText(format(output));
    expect(text).toContain('2 nutrients');
    // IDs and names must appear so the LLM can map names → IDs
    expect(text).toContain('1003');
    expect(text).toContain('Protein');
    expect(text).toContain('1162');
    expect(text).toContain('Vitamin C');
    expect(text).toContain('203'); // SR number
  });
});
