/**
 * @fileoverview Resource exposing the full FDC nutrient reference list via usda://nutrients.
 * @module mcp-server/resources/definitions/usda-nutrients
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { NUTRIENT_REFERENCE } from '@/services/fdc/nutrient-reference.js';

export const usdaNutrientsResource = resource('usda://nutrients', {
  name: 'USDA Nutrient Reference',
  description:
    'Complete FDC nutrient reference list — all ~150 tracked nutrients with their numeric IDs, names, SR reference numbers, units, and categories. Use this to resolve nutrient names to FDC IDs for use in nutrients[] parameters on other tools.',
  mimeType: 'application/json',
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
