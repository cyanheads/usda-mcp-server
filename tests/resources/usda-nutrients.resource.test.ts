/**
 * @fileoverview Tests for usda_nutrients resource (usda://nutrients).
 * @module tests/resources/usda-nutrients.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { usdaNutrientsResource } from '@/mcp-server/resources/definitions/usda-nutrients.resource.js';

// No service dependency — reads from static NUTRIENT_REFERENCE

describe('usdaNutrientsResource', () => {
  it('returns the nutrient reference list', async () => {
    const ctx = createMockContext();
    const params = usdaNutrientsResource.params.parse({});
    const result = await usdaNutrientsResource.handler(params, ctx);

    expect(result).toHaveProperty('nutrients');
    const { nutrients } = result as { nutrients: Array<{ id: number; name: string }> };
    expect(nutrients.length).toBeGreaterThan(0);
  });

  it('includes well-known nutrient IDs', async () => {
    const ctx = createMockContext();
    const params = usdaNutrientsResource.params.parse({});
    const result = await usdaNutrientsResource.handler(params, ctx);
    const { nutrients } = result as { nutrients: Array<{ id: number }> };
    const ids = nutrients.map((n) => n.id);

    expect(ids).toContain(1008); // Energy
    expect(ids).toContain(1003); // Protein
    expect(ids).toContain(1162); // Vitamin C
  });

  it('lists the nutrients resource', async () => {
    const listing = await usdaNutrientsResource.list!();
    expect(listing.resources).toBeInstanceOf(Array);
    expect(listing.resources.length).toBeGreaterThan(0);
    for (const r of listing.resources) {
      expect(r).toHaveProperty('uri');
      expect(r).toHaveProperty('name');
    }
    expect(listing.resources[0].uri).toBe('usda://nutrients');
  });
});
