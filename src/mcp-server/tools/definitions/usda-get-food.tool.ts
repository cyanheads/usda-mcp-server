/**
 * @fileoverview Full nutrient profile for one food by FDC ID, with optional per-portion scaling.
 * @module mcp-server/tools/definitions/usda-get-food
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getFdcService } from '@/services/fdc/fdc-service.js';

/** Convert an amount in grams to the requested unit. */
function toGrams(quantity: number, unit: string): number {
  switch (unit) {
    case 'g':
      return quantity;
    case 'oz':
      return quantity * 28.3495;
    case 'lb':
      return quantity * 453.592;
    case 'kg':
      return quantity * 1000;
    default:
      throw new Error(`Unsupported unit: ${unit}`);
  }
}

export const usdaGetFood = tool('usda_get_food', {
  title: 'Get USDA Food',
  description:
    'Full nutrient profile for one food by FDC ID. Returns all available nutrients (or a filtered subset via the nutrients[] param) with optional per-portion scaling. Use usda_search_foods to discover FDC IDs. Provide quantity + unit to scale all nutrient values from per-100g to the specified portion (e.g. quantity=200, unit="g" → per-200g values). Use unit="serving" to scale to the food\'s first defined portion weight. Filtering nutrients[] to just the IDs you need reduces context size for common queries.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    fdcId: z.number().int().describe('FDC ID of the food. Use usda_search_foods to discover IDs.'),
    nutrients: z
      .array(z.number().int())
      .optional()
      .describe(
        'Filter to specific nutrient IDs (e.g. [1003, 1004, 1005, 1008] for protein, fat, carbs, energy). Use usda_list_nutrients to look up IDs. Omit to return all available nutrients.',
      ),
    quantity: z
      .number()
      .optional()
      .describe(
        'Amount of food to scale nutrient values to. When provided, unit is required. Omit for per-100g values (FDC database native basis).',
      ),
    unit: z
      .enum(['g', 'oz', 'lb', 'kg', 'serving'])
      .optional()
      .describe(
        'Unit for quantity. "serving" uses the food\'s first defined portion weight. Required when quantity is provided.',
      ),
  }),
  output: z.object({
    fdcId: z.number().describe('FDC ID of the food.'),
    description: z.string().describe('USDA food description.'),
    dataType: z
      .string()
      .describe('FDC data source: SR Legacy, Foundation, Survey (FNDDS), or Branded.'),
    foodCategory: z.string().optional().describe('USDA food category.'),
    publicationDate: z.string().optional().describe('FDC publication date.'),
    brandOwner: z.string().optional().describe('Brand owner. Branded items only.'),
    brandName: z.string().optional().describe('Brand name. Branded items only.'),
    ingredients: z.string().optional().describe('Ingredient list from label. Branded items only.'),
    servingInfo: z
      .object({
        description: z.string().describe('Portion description (e.g. "1 cup", "4 oz").'),
        gramWeight: z.number().describe('Gram weight of this portion.'),
      })
      .optional()
      .describe('First available portion definition, if present.'),
    allPortions: z
      .array(
        z
          .object({
            description: z.string().describe('Portion description.'),
            gramWeight: z.number().describe('Gram weight of this portion.'),
          })
          .describe('A named portion for this food.'),
      )
      .optional()
      .describe('All named portions for this food.'),
    scaledTo: z
      .object({
        quantity: z.number().describe('The quantity value that was requested.'),
        unit: z.string().describe('The unit that was requested.'),
        gramWeight: z.number().describe('Resolved gram weight used for scaling.'),
      })
      .optional()
      .describe(
        'Scaling basis when quantity+unit were provided. Absent when returning per-100g values.',
      ),
    nutrients: z
      .array(
        z
          .object({
            id: z.number().describe('FDC nutrient ID.'),
            name: z.string().describe('Nutrient name (e.g. "Protein", "Energy", "Iron, Fe").'),
            number: z.string().describe('SR reference number (legacy identifier).'),
            amount: z
              .number()
              .describe('Nutrient amount — per 100g, or scaled to quantity+unit if provided.'),
            unit: z.string().describe('Measurement unit (e.g. "G", "MG", "KCAL").'),
            percentDailyValue: z
              .number()
              .optional()
              .describe('Percent daily value from product label. Branded items only.'),
          })
          .describe('A single nutrient entry with ID, name, amount, and unit.'),
      )
      .describe('Nutrient values for this food, per 100g or scaled to the requested quantity.'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The FDC ID does not exist in the database.',
      recovery: 'Verify the FDC ID using usda_search_foods and try again with a valid ID.',
    },
    {
      reason: 'no_portion_data',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'unit="serving" was requested but the food has no portion data.',
      recovery: 'Use a gram-based unit (g, oz, lb, kg) instead of serving for this food.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching food detail', { fdcId: input.fdcId, nutrients: input.nutrients });

    const food = await getFdcService()
      .getFoodDetail(input.fdcId, input.nutrients?.length ? input.nutrients : undefined, ctx)
      .catch((err: unknown) => {
        // 404 from the API → not_found contract entry
        if (
          err instanceof Error &&
          (err.message.includes('404') || err.message.toLowerCase().includes('not found'))
        ) {
          throw ctx.fail('not_found', `FDC ID ${input.fdcId} not found.`, {
            fdcId: input.fdcId,
            ...ctx.recoveryFor('not_found'),
          });
        }
        throw err;
      });

    // Portion scaling
    let scaledTo: { quantity: number; unit: string; gramWeight: number } | undefined;
    let scaleFactor = 1;

    if (input.quantity != null && input.unit) {
      let gramWeight: number;

      if (input.unit === 'serving') {
        if (food.portions.length === 0) {
          throw ctx.fail(
            'no_portion_data',
            `Food "${food.description}" (ID ${food.fdcId}) has no portion data.`,
            { fdcId: food.fdcId, ...ctx.recoveryFor('no_portion_data') },
          );
        }
        gramWeight = food.portions[0]?.gramWeight ?? 0;
      } else {
        gramWeight = toGrams(input.quantity, input.unit);
      }

      scaleFactor = gramWeight / 100;
      scaledTo = { quantity: input.quantity, unit: input.unit, gramWeight };
    }

    const nutrients = food.nutrients.map((n) => ({
      ...n,
      amount: Number((n.amount * scaleFactor).toFixed(4)),
    }));

    const result: Record<string, unknown> = {
      fdcId: food.fdcId,
      description: food.description,
      dataType: food.dataType,
      nutrients,
    };

    if (food.foodCategory) result.foodCategory = food.foodCategory;
    if (food.publicationDate) result.publicationDate = food.publicationDate;
    if (food.brandOwner) result.brandOwner = food.brandOwner;
    if (food.brandName) result.brandName = food.brandName;
    if (food.ingredients) result.ingredients = food.ingredients;
    if (scaledTo) result.scaledTo = scaledTo;

    if (food.portions.length > 0) {
      result.servingInfo = food.portions[0];
      result.allPortions = food.portions;
    }

    return result as {
      fdcId: number;
      description: string;
      dataType: string;
      foodCategory?: string;
      publicationDate?: string;
      brandOwner?: string;
      brandName?: string;
      ingredients?: string;
      servingInfo?: { description: string; gramWeight: number };
      allPortions?: Array<{ description: string; gramWeight: number }>;
      scaledTo?: { quantity: number; unit: string; gramWeight: number };
      nutrients: Array<{
        id: number;
        name: string;
        number: string;
        amount: number;
        unit: string;
        percentDailyValue?: number;
      }>;
    };
  },

  format: (result) => {
    const lines: string[] = [];

    lines.push(`## ${result.description}`);
    lines.push(`**FDC ID:** ${result.fdcId} | **Type:** ${result.dataType}`);
    if (result.foodCategory) lines.push(`**Category:** ${result.foodCategory}`);
    if (result.brandOwner) lines.push(`**Brand Owner:** ${result.brandOwner}`);
    if (result.brandName) lines.push(`**Brand:** ${result.brandName}`);
    if (result.publicationDate) lines.push(`**Published:** ${result.publicationDate}`);
    if (result.ingredients) lines.push(`**Ingredients:** ${result.ingredients}`);

    if (result.scaledTo) {
      lines.push(
        `\n**Basis:** ${result.scaledTo.quantity} ${result.scaledTo.unit} (${result.scaledTo.gramWeight.toFixed(1)}g)`,
      );
    } else {
      lines.push('\n**Basis:** per 100g');
    }

    if (result.servingInfo) {
      lines.push(
        `**Serving:** ${result.servingInfo.description} = ${result.servingInfo.gramWeight}g`,
      );
    }

    if (result.allPortions && result.allPortions.length > 0) {
      lines.push(
        `**All portions:** ${result.allPortions.map((p) => `${p.description} (${p.gramWeight}g)`).join(', ')}`,
      );
    }

    lines.push('\n### Nutrients');
    for (const n of result.nutrients) {
      const pdv = n.percentDailyValue != null ? ` (${n.percentDailyValue}% DV)` : '';
      lines.push(`- **${n.name}** (ID: ${n.id}, SR#: ${n.number}): ${n.amount} ${n.unit}${pdv}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
