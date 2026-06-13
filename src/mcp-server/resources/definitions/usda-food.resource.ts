/**
 * @fileoverview Resource exposing a food's full nutrient profile by FDC ID via usda://food/{fdcId}.
 * @module mcp-server/resources/definitions/usda-food
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getFdcService } from '@/services/fdc/fdc-service.js';

export const usdaFoodResource = resource('usda://food/{fdcId}', {
  name: 'USDA Food Profile',
  description:
    'Full nutrient profile for a specific food by FDC ID. Returns all available nutrients per 100g — equivalent to usda_get_food without portion scaling. Use usda_search_foods to discover FDC IDs.',
  mimeType: 'application/json',
  params: z.object({
    fdcId: z.string().describe('FDC ID of the food (numeric string, e.g. "171077").'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The FDC ID does not exist in the database.',
      recovery: 'Verify the FDC ID using usda_search_foods and use a valid numeric ID.',
    },
    {
      reason: 'invalid_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The fdcId parameter is not a valid integer.',
      recovery: 'Provide a numeric FDC ID from usda_search_foods results.',
    },
  ],

  async handler(params, ctx) {
    const fdcId = parseInt(params.fdcId, 10);
    if (Number.isNaN(fdcId) || fdcId <= 0) {
      throw ctx.fail('invalid_id', `"${params.fdcId}" is not a valid FDC ID.`, {
        fdcId: params.fdcId,
        ...ctx.recoveryFor('invalid_id'),
      });
    }

    ctx.log.debug('Fetching food resource', { fdcId });

    const food = await getFdcService()
      .getFoodDetail(fdcId, undefined, ctx)
      .catch((err: unknown) => {
        if (
          err instanceof Error &&
          (err.message.includes('404') || err.message.toLowerCase().includes('not found'))
        ) {
          throw ctx.fail('not_found', `FDC ID ${fdcId} not found.`, {
            fdcId,
            ...ctx.recoveryFor('not_found'),
          });
        }
        throw err;
      });

    return food;
  },
});
