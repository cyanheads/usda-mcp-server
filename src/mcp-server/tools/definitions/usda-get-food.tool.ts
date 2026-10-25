/**
 * @fileoverview Full nutrient profile for one food by FDC ID, with optional per-portion scaling.
 * @module mcp-server/tools/definitions/usda-get-food
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getFdcService } from '@/services/fdc/fdc-service.js';

function toGrams(quantity: number, unit: 'g' | 'oz' | 'lb' | 'kg'): number {
  switch (unit) {
    case 'g':
      return quantity;
    case 'oz':
      return quantity * 28.3495;
    case 'lb':
      return quantity * 453.592;
    case 'kg':
      return quantity * 1000;
  }
}

export const usdaGetFood = tool('usda_get_food', {
  title: 'Get USDA Food',
  description:
    'Get the full nutrient profile for one food by FDC ID. Returns all available nutrients (or a filtered subset via the nutrients[] param) with optional per-portion scaling. Use usda_search_foods to discover FDC IDs. Provide unit, optionally with quantity, to scale all nutrient values from per-100g to that amount (e.g. quantity=200, unit="g" → per-200g values). quantity defaults to 100 for g, oz, lb, and kg and to 1 for serving; unit="serving" is the food\'s first defined portion weight times quantity (quantity=2, unit="serving" → two portions). quantity without unit is rejected. Narrow nutrients[] to specific IDs to reduce response size for focused queries.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    fdcId: z
      .number()
      .int()
      .min(1)
      .describe('FDC ID of the food. Use usda_search_foods to discover IDs.'),
    nutrients: z
      .array(z.number().int().min(1))
      .optional()
      .describe(
        'Filter to specific nutrient IDs (e.g. [1003, 1004, 1005, 1008] for protein, fat, carbs, energy). Use usda_list_nutrients to look up IDs. Omit to return all available nutrients.',
      ),
    quantity: z
      .number()
      .positive()
      .optional()
      .describe(
        'Amount of food, in unit, to scale nutrient values to. Must be positive. Requires unit. Defaults to 100 when unit is g, oz, lb, or kg, and to 1 when unit is "serving". Omit both quantity and unit for per-100g values (FDC database native basis).',
      ),
    unit: z
      .enum(['g', 'oz', 'lb', 'kg', 'serving'])
      .optional()
      .describe(
        'Unit for quantity. "serving" is the food\'s first defined portion weight, multiplied by quantity. Required when quantity is provided. Given alone, scales to 100 g, oz, lb, or kg, or to 1 serving.',
      ),
  }),
  output: z.object({
    fdcId: z.number().describe('FDC ID of the food.'),
    description: z
      .string()
      .describe(
        'Full USDA food name (e.g. "Chicken, broilers or fryers, breast, meat only, raw").',
      ),
    dataType: z
      .string()
      .describe('FDC data source: SR Legacy, Foundation, Survey (FNDDS), or Branded.'),
    foodCategory: z
      .string()
      .optional()
      .describe('USDA food category (e.g. "Poultry Products"). Absent for some branded items.'),
    publicationDate: z.string().optional().describe('Date this food entry was published in FDC.'),
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
        quantity: z
          .number()
          .describe(
            'Quantity applied — the requested value, or the default for unit (100 for g, oz, lb, kg; 1 for serving).',
          ),
        unit: z.string().describe('Unit provided in the request (g, oz, lb, kg, or serving).'),
        gramWeight: z
          .number()
          .describe(
            'Gram weight resolved from quantity and unit (for serving, quantity × the first portion weight) — all nutrient values are per this many grams.',
          ),
      })
      .optional()
      .describe('Scaling basis when unit was provided. Absent when returning per-100g values.'),
    nutrients: z
      .array(
        z
          .object({
            id: z.number().describe('FDC nutrient ID.'),
            name: z.string().describe('Nutrient name (e.g. "Protein", "Energy", "Iron, Fe").'),
            number: z.string().describe('SR reference number (legacy identifier).'),
            amount: z
              .number()
              .describe(
                'Nutrient amount — per 100g, or per scaledTo.gramWeight when unit is provided.',
              ),
            unit: z.string().describe('Measurement unit (e.g. "G", "MG", "KCAL").'),
            percentDailyValue: z
              .number()
              .optional()
              .describe('Percent daily value from product label. Branded items only.'),
          })
          .describe('A single nutrient entry with ID, name, amount, and unit.'),
      )
      .describe('Nutrient values for this food, per 100g or scaled to the scaledTo basis.'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The FDC ID does not exist in the database.',
      recovery: 'Verify the FDC ID using usda_search_foods and try again with a valid ID.',
      severity: 'notice',
    },
    {
      reason: 'quantity_without_unit',
      code: JsonRpcErrorCode.ValidationError,
      when: 'quantity is provided but unit is omitted.',
      recovery: 'Provide unit (g, oz, lb, kg, or serving) alongside quantity.',
      severity: 'notice',
    },
    {
      reason: 'no_portion_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'unit="serving" was requested but the food has no portion data.',
      recovery: 'Use a gram-based unit (g, oz, lb, kg) instead of serving for this food.',
      severity: 'notice',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching food detail', { fdcId: input.fdcId, nutrients: input.nutrients });

    if (input.quantity != null && !input.unit) {
      throw ctx.fail('quantity_without_unit', 'unit is required when quantity is provided.', {
        recovery: { hint: 'Provide unit (g, oz, lb, kg, or serving) alongside quantity.' },
      });
    }

    const food = await getFdcService()
      .getFoodDetail(input.fdcId, input.nutrients?.length ? input.nutrients : undefined, ctx)
      .catch((err: unknown) => {
        // FDC's HTTP 404 (the status the service's McpError carries) → not_found contract entry
        if (err instanceof McpError && err.data?.status === 404) {
          throw ctx.fail(
            'not_found',
            `FDC ID ${input.fdcId} not found.`,
            { fdcId: input.fdcId },
            { cause: err },
          );
        }
        throw err;
      });

    // Portion scaling — unit alone takes its default quantity (1 serving, 100 of a mass unit)
    let scaledTo: { quantity: number; unit: string; gramWeight: number } | undefined;
    let scaleFactor = 1;

    if (input.unit) {
      const quantity = input.quantity ?? (input.unit === 'serving' ? 1 : 100);
      let gramWeight: number;

      if (input.unit === 'serving') {
        const [portion] = food.portions;
        if (!portion) {
          throw ctx.fail(
            'no_portion_data',
            `Food "${food.description}" (ID ${food.fdcId}) has no portion data.`,
            { fdcId: food.fdcId },
          );
        }
        gramWeight = quantity * portion.gramWeight;
      } else {
        gramWeight = toGrams(quantity, input.unit);
      }

      // Same 4-decimal precision as nutrient amounts, so format() can render it verbatim
      gramWeight = Number(gramWeight.toFixed(4));
      scaleFactor = gramWeight / 100;
      scaledTo = { quantity, unit: input.unit, gramWeight };
    }

    return {
      fdcId: food.fdcId,
      description: food.description,
      dataType: food.dataType,
      ...(food.foodCategory && { foodCategory: food.foodCategory }),
      ...(food.publicationDate && { publicationDate: food.publicationDate }),
      ...(food.brandOwner && { brandOwner: food.brandOwner }),
      ...(food.brandName && { brandName: food.brandName }),
      ...(food.ingredients && { ingredients: food.ingredients }),
      ...(scaledTo && { scaledTo }),
      ...(food.portions.length > 0 && {
        servingInfo: food.portions[0],
        allPortions: food.portions,
      }),
      nutrients: food.nutrients.map((n) => ({
        ...n,
        amount: Number((n.amount * scaleFactor).toFixed(4)),
      })),
    };
  },

  format: (result) => {
    const lines: string[] = [];

    // FDC-supplied free text goes through escapeMarkdownInline so content[] reads back as written.
    lines.push(`## ${escapeMarkdownInline(result.description)}`);
    lines.push(`**FDC ID:** ${result.fdcId} | **Type:** ${result.dataType}`);
    if (result.foodCategory) {
      lines.push(`**Category:** ${escapeMarkdownInline(result.foodCategory)}`);
    }
    if (result.brandOwner) {
      lines.push(`**Brand Owner:** ${escapeMarkdownInline(result.brandOwner)}`);
    }
    if (result.brandName) lines.push(`**Brand:** ${escapeMarkdownInline(result.brandName)}`);
    if (result.publicationDate) lines.push(`**Published:** ${result.publicationDate}`);
    if (result.ingredients) {
      lines.push(`**Ingredients:** ${escapeMarkdownInline(result.ingredients)}`);
    }

    if (result.scaledTo) {
      lines.push(
        `\n**Basis:** ${result.scaledTo.quantity} ${result.scaledTo.unit} (${result.scaledTo.gramWeight}g)`,
      );
    } else {
      lines.push('\n**Basis:** per 100g');
    }

    if (result.servingInfo) {
      lines.push(
        `**Serving:** ${escapeMarkdownInline(result.servingInfo.description)} = ${result.servingInfo.gramWeight}g`,
      );
    }

    if (result.allPortions && result.allPortions.length > 0) {
      lines.push(
        `**All portions:** ${result.allPortions.map((p) => `${escapeMarkdownInline(p.description)} (${p.gramWeight}g)`).join(', ')}`,
      );
    }

    lines.push('\n### Nutrients');
    for (const n of result.nutrients) {
      const pdv = n.percentDailyValue != null ? ` (${n.percentDailyValue}% DV)` : '';
      lines.push(
        `- **${escapeMarkdownInline(n.name)}** (ID: ${n.id}, SR#: ${n.number}): ${n.amount} ${n.unit}${pdv}`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
