/**
 * @fileoverview Resource exposing the full FDC nutrient reference list via usda://nutrients.
 * @module mcp-server/resources/definitions/usda-nutrients
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { NUTRIENT_REFERENCE } from '@/services/fdc/nutrient-reference.js';

export const usdaNutrientsResource = resource('usda://nutrients', {
  name: 'USDA Nutrient Reference',
  description:
    'Access the complete FDC nutrient reference — all ~150 tracked nutrients with their numeric IDs, names, SR reference numbers, units, and categories. Use to resolve nutrient names to FDC IDs for the nutrients[] filter on usda_get_food, usda_get_foods, usda_compare_foods, and usda_list_nutrients.',
  mimeType: 'application/json',
  /**
   * The nutrient table is bundled at build time and never varies by caller, so
   * a 2026-07-28 client may hold it for the life of the deployed version. One
   * hour is well inside that, and the scope is public because every tenant gets
   * byte-identical bytes.
   */
  cacheHint: { ttlMs: 3_600_000, cacheScope: 'public' },
  params: z.object({}),

  // biome-ignore lint/suspicious/useAwait: framework requires async handler signature
  async handler(_params, ctx) {
    ctx.log.debug('Serving nutrient reference resource');
    return { nutrients: NUTRIENT_REFERENCE };
  },

  list: async () => ({
    resources: [
      {
        uri: 'usda://nutrients',
        name: 'USDA Nutrient Reference',
        description: 'All tracked FDC nutrients with IDs, names, units, and categories.',
        mimeType: 'application/json',
      },
    ],
  }),
});
