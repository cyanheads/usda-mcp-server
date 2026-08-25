/**
 * @fileoverview Tests for usda_nutrients resource (usda://nutrients).
 * @module tests/resources/usda-nutrients.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { usdaNutrientsResource } from '@/mcp-server/resources/definitions/usda-nutrients.resource.js';

// No service dependency — reads from static NUTRIENT_REFERENCE

const { params: nutrientParams, list } = usdaNutrientsResource;
if (!nutrientParams) throw new Error('usda://nutrients must declare params');
if (!list) throw new Error('usda://nutrients must declare list()');

describe('usdaNutrientsResource', () => {
  it('returns the nutrient reference list', async () => {
    const ctx = createMockContext();
    const params = nutrientParams.parse({});
    const result = await usdaNutrientsResource.handler(params, ctx);

    expect(result).toHaveProperty('nutrients');
    const { nutrients } = result as { nutrients: Array<{ id: number; name: string }> };
    expect(nutrients.length).toBeGreaterThan(0);
  });

  it('includes well-known nutrient IDs', async () => {
    const ctx = createMockContext();
    const params = nutrientParams.parse({});
    const result = await usdaNutrientsResource.handler(params, ctx);
    const { nutrients } = result as { nutrients: Array<{ id: number }> };
    const ids = nutrients.map((n) => n.id);

    expect(ids).toContain(1008); // Energy
    expect(ids).toContain(1003); // Protein
    expect(ids).toContain(1162); // Vitamin C
  });

  it('declares a public cache hint — the table is bundled, not fetched', () => {
    // Only ever byte-identical per deployed version, so a 2026-07-28 client may
    // hold it across tenants. A regression to `private`/0 would make every read
    // a round trip for data that cannot change without a redeploy.
    expect(usdaNutrientsResource.cacheHint).toEqual({
      ttlMs: 3_600_000,
      cacheScope: 'public',
    });
  });

  it('lists the nutrients resource', async () => {
    /**
     * `list` receives the SDK's `ServerContext`, not a framework `Context`.
     * This listing ignores it entirely, so an empty stand-in cast to the
     * declared parameter type is the honest stub — hand-building the SDK's
     * shape would only pin a type this server never reads.
     */
    const listing = await list({} as Parameters<typeof list>[0]);
    expect(listing.resources).toBeInstanceOf(Array);
    expect(listing.resources.length).toBeGreaterThan(0);
    for (const r of listing.resources) {
      expect(r).toHaveProperty('uri');
      expect(r).toHaveProperty('name');
    }
    expect(listing.resources[0]).toMatchObject({ uri: 'usda://nutrients' });
  });
});
