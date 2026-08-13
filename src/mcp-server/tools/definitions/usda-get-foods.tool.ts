/**
 * @fileoverview Batch nutrient profile fetch for multiple foods by FDC ID.
 * @module mcp-server/tools/definitions/usda-get-foods
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getFdcService } from '@/services/fdc/fdc-service.js';

export const usdaGetFoods = tool('usda_get_foods', {
  title: 'Get USDA Foods (Batch)',
  description:
    'Fetch nutrient profiles for 2–20 foods in a single API call. More efficient than calling usda_get_food N times when you already have multiple FDC IDs. All values are per 100g (no portion scaling). Use the nutrients[] filter to limit response size — strongly recommended for batch calls. For side-by-side comparison with a formatted table, use usda_compare_foods instead. Failed IDs (not found or no data) are reported in the failed[] array rather than aborting the entire batch.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    fdcIds: z
      .array(z.number().int().min(1))
      .min(2)
      .max(20)
      .describe('FDC IDs to fetch — 2 to 20 IDs. Use usda_search_foods to discover IDs.'),
    nutrients: z
      .array(z.number().int().min(1))
      .optional()
      .describe(
        'Filter to specific nutrient IDs (e.g. [1003, 1004, 1005, 1008]). Strongly recommended — full profiles can be large. Use usda_list_nutrients to look up IDs.',
      ),
  }),
  output: z.object({
    foods: z
      .array(
        z
          .object({
            fdcId: z.number().describe('FDC ID of this food.'),
            description: z
              .string()
              .describe(
                'Full USDA food name (e.g. "Chicken, broilers or fryers, breast, meat only, raw").',
              ),
            dataType: z
              .string()
              .describe('FDC data source: SR Legacy, Foundation, Survey (FNDDS), or Branded.'),
            nutrients: z
              .array(
                z
                  .object({
                    id: z.number().describe('FDC nutrient ID.'),
                    name: z.string().describe('Nutrient name.'),
                    number: z.string().describe('SR reference number.'),
                    amount: z.number().describe('Amount per 100g.'),
                    unit: z.string().describe('Measurement unit (e.g. "G", "MG", "KCAL").'),
                  })
                  .describe('A nutrient entry with ID, name, amount, and unit.'),
              )
              .describe('Nutrient values per 100g.'),
          })
          .describe('Nutrient profile for one food.'),
      )
      .describe('Successfully fetched foods.'),
    failed: z
      .array(
        z
          .object({
            fdcId: z.number().describe('FDC ID that could not be fetched.'),
            error: z.string().describe('Why this ID failed — not found, no data returned, etc.'),
          })
          .describe('A failed food fetch with the FDC ID and error reason.'),
      )
      .describe(
        'IDs that returned no data. Check these with usda_search_foods to verify they exist.',
      ),
  }),

  async handler(input, ctx) {
    ctx.log.info('Fetching batch foods', { count: input.fdcIds.length });

    const { foods, failed } = await getFdcService().getFoodsBatch(
      input.fdcIds,
      input.nutrients?.length ? input.nutrients : undefined,
      ctx,
    );

    ctx.log.info('Batch complete', { succeeded: foods.length, failed: failed.length });

    return {
      foods: foods.map((f) => ({
        fdcId: f.fdcId,
        description: f.description,
        dataType: f.dataType,
        nutrients: f.nutrients.map((n) => ({
          id: n.id,
          name: n.name,
          number: n.number,
          amount: n.amount,
          unit: n.unit,
        })),
      })),
      failed,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**${result.foods.length} foods fetched** | **${result.failed.length} failed**\n`,
    ];

    for (const food of result.foods) {
      lines.push(`### ${food.description}`);
      lines.push(`**FDC ID:** ${food.fdcId} | **Type:** ${food.dataType}`);
      if (food.nutrients.length > 0) {
        lines.push('**Nutrients (per 100g):**');
        for (const n of food.nutrients) {
          lines.push(`- ${n.name} (ID: ${n.id}, SR#: ${n.number}): ${n.amount} ${n.unit}`);
        }
      } else {
        lines.push('*No nutrients returned for this food.*');
      }
      lines.push('');
    }

    if (result.failed.length > 0) {
      lines.push('### Failed IDs');
      for (const f of result.failed) {
        lines.push(`- FDC ID ${f.fdcId}: ${f.error}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
