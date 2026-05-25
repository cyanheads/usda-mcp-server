/**
 * @fileoverview Tests for usda_list_nutrients tool.
 * @module tests/tools/usda-list-nutrients.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { usdaListNutrients } from '@/mcp-server/tools/definitions/usda-list-nutrients.tool.js';

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

  it('formats output with count and nutrient rows including IDs', () => {
    const output = {
      nutrients: [
        { id: 1003, name: 'Protein', number: '203', unit: 'G', category: 'macronutrients' },
        { id: 1162, name: 'Vitamin C', number: '401', unit: 'MG', category: 'vitamins' },
      ],
    };
    const blocks = usdaListNutrients.format!(output);
    expect(blocks[0].type).toBe('text');
    const text = blocks[0].text;
    expect(text).toContain('2 nutrients');
    // IDs and names must appear so the LLM can map names → IDs
    expect(text).toContain('1003');
    expect(text).toContain('Protein');
    expect(text).toContain('1162');
    expect(text).toContain('Vitamin C');
    expect(text).toContain('203'); // SR number
  });
});
