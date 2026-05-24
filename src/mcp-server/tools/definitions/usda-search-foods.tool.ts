/**
 * @fileoverview Search USDA FoodData Central foods by keyword, with a preview of key nutrients.
 * @module mcp-server/tools/definitions/usda-search-foods
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { type FdcService, getFdcService } from '@/services/fdc/fdc-service.js';

export const usdaSearchFoods = tool('usda_search_foods', {
  title: 'Search USDA Foods',
  description:
    'Search USDA FoodData Central foods by keyword. Returns matching foods with FDC IDs and a preview of key nutrients (energy, protein, fat, carbs — not guaranteed complete). Use the returned fdcId with usda_get_food for the full nutrient profile, or usda_compare_foods for side-by-side comparisons. Defaults to SR Legacy (common whole foods with complete profiles); set dataType to ["Branded"] for packaged products, or include a UPC/GTIN code as the query. Pass brandOwner (e.g. "General Mills") to narrow branded results.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .describe(
        'Search terms — food name, ingredient, or UPC/GTIN code for branded products. Examples: "chicken breast raw", "banana", "012345678901".',
      ),
    dataType: z
      .array(z.enum(['SR Legacy', 'Foundation', 'Survey (FNDDS)', 'Branded']))
      .optional()
      .describe(
        'FDC data sources to search. Defaults to ["SR Legacy"] (common whole foods, complete nutrient profiles). Include "Branded" for packaged products. Multiple values allowed.',
      ),
    brandOwner: z
      .string()
      .optional()
      .describe(
        'Filter branded results by brand owner name (e.g. "General Mills", "Kraft"). Only meaningful when Branded is in dataType.',
      ),
    foodCategory: z
      .string()
      .optional()
      .describe(
        'Filter by USDA food category (e.g. "Poultry Products", "Vegetables and Vegetable Products"). Case-sensitive.',
      ),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Number of results per page. Default 10, maximum 50.'),
    pageNumber: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe('Page number (1-based). Use with totalPages to paginate.'),
  }),
  output: z.object({
    totalHits: z.number().describe('Total number of foods matching the query across all pages.'),
    currentPage: z.number().describe('Current page number (1-based).'),
    totalPages: z.number().describe('Total number of pages available.'),
    foods: z
      .array(
        z
          .object({
            fdcId: z
              .number()
              .describe('FDC ID — pass to usda_get_food, usda_get_foods, or usda_compare_foods.'),
            description: z
              .string()
              .describe(
                'USDA food description (e.g. "Chicken, broilers or fryers, breast, meat only, raw").',
              ),
            dataType: z
              .string()
              .describe('FDC data source: SR Legacy, Foundation, Survey (FNDDS), or Branded.'),
            foodCategory: z
              .string()
              .optional()
              .describe(
                'USDA food category (e.g. "Poultry Products"). Absent for some branded items.',
              ),
            brandOwner: z
              .string()
              .optional()
              .describe('Brand owner name. Present for Branded items only.'),
            brandName: z
              .string()
              .optional()
              .describe('Brand name. Present for Branded items only.'),
            servingSize: z
              .number()
              .optional()
              .describe('Serving size in grams from the product label. Branded only.'),
            servingSizeUnit: z
              .string()
              .optional()
              .describe('Unit for servingSize (usually "g"). Branded only.'),
            householdServingFullText: z
              .string()
              .optional()
              .describe(
                'Serving description as it appears on the label (e.g. "1 cup", "1 oz"). Branded only.',
              ),
            nutrients: z
              .array(
                z
                  .object({
                    id: z.number().describe('FDC nutrient ID.'),
                    name: z.string().describe('Nutrient name.'),
                    amount: z.number().describe('Amount per 100g.'),
                    unit: z.string().describe('Unit (e.g. "G", "MG", "KCAL").'),
                  })
                  .describe('A preview nutrient entry with ID, name, and amount per 100g.'),
              )
              .describe(
                'Preview nutrients per 100g — typically energy, protein, fat, carbs for SR Legacy. Not a complete profile; use usda_get_food for the full set.',
              ),
            publishedDate: z
              .string()
              .optional()
              .describe('Date the food entry was published in FDC.'),
          })
          .describe('A food item matching the search query.'),
      )
      .describe('Foods matching the search query.'),
  }),

  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'No foods matched the query in the specified data sources.',
      recovery:
        'Broaden the query, check spelling, or try a different dataType (e.g. add "Branded").',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Searching foods', {
      query: input.query,
      dataType: input.dataType,
      pageSize: input.pageSize,
    });

    const searchParams: Parameters<FdcService['searchFoods']>[0] = {
      query: input.query,
      dataType: input.dataType?.length ? input.dataType : ['SR Legacy'],
      pageSize: input.pageSize,
      pageNumber: input.pageNumber,
    };
    if (input.brandOwner?.trim()) searchParams.brandOwner = input.brandOwner.trim();
    if (input.foodCategory?.trim()) searchParams.foodCategory = input.foodCategory.trim();

    const result = await getFdcService().searchFoods(searchParams, ctx);

    if (result.foods.length === 0) {
      const dtLabel = (input.dataType ?? ['SR Legacy']).join(', ');
      throw ctx.fail('no_results', `No foods matched "${input.query}" in ${dtLabel}.`, {
        query: input.query,
        dataType: input.dataType,
        recovery: {
          hint: `No foods matched "${input.query}" in ${dtLabel}. Try a simpler query, check spelling, or add "Branded" to dataType.`,
        },
      });
    }

    return {
      totalHits: result.totalHits,
      currentPage: result.currentPage,
      totalPages: result.totalPages,
      foods: result.foods,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**${result.totalHits} total hits** — page ${result.currentPage} of ${result.totalPages}\n`,
    ];

    for (const food of result.foods) {
      lines.push(`### ${food.description}`);
      lines.push(`**FDC ID:** ${food.fdcId} | **Type:** ${food.dataType}`);
      if (food.foodCategory) lines.push(`**Category:** ${food.foodCategory}`);
      if (food.brandOwner) lines.push(`**Brand Owner:** ${food.brandOwner}`);
      if (food.brandName) lines.push(`**Brand:** ${food.brandName}`);
      if (food.servingSize != null) {
        lines.push(
          `**Serving:** ${food.servingSize}${food.servingSizeUnit ?? 'g'}${food.householdServingFullText ? ` (${food.householdServingFullText})` : ''}`,
        );
      }
      if (food.nutrients.length > 0) {
        lines.push(
          `**Nutrients (per 100g):** ${food.nutrients.map((n) => `${n.name} (ID:${n.id}): ${n.amount}${n.unit}`).join(' | ')}`,
        );
      }
      if (food.publishedDate) lines.push(`**Published:** ${food.publishedDate}`);
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
