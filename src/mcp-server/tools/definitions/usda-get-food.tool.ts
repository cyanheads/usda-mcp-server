/**
 * @fileoverview Full nutrient profile for one food by FDC ID, with optional per-portion scaling.
 * @module mcp-server/tools/definitions/usda-get-food
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import {
  BASIS_UNIT_DESCRIPTION,
  type BasisUnit,
  basisLabel,
  labelUnitBasis,
} from '@/services/fdc/basis.js';
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

interface ScaledTo {
  gramWeight: number;
  quantity: number;
  unit: string;
}

/**
 * The caveat a scaled request carries when the food is not per 100 g: the
 * resolved amount was applied to its ml or label-unit basis as-is. Undefined
 * for a per-100 g food.
 */
function basisNotice(
  scaledTo: ScaledTo,
  basisUnit: BasisUnit | undefined,
  servingSizeUnit: string | undefined,
): string | undefined {
  const requested = `${scaledTo.quantity} ${scaledTo.unit}`;
  switch (basisUnit) {
    case 'g':
      return;
    case 'ml':
      return `FDC reports this food per 100 ml (label serving in ml); ${requested} was applied as ${scaledTo.gramWeight} ml without density conversion.`;
    case undefined:
      return `FDC computed this food's values per 100 label units (${servingSizeUnit?.trim() || 'no label unit'}); ${requested} was applied to that basis unconverted.`;
  }
}

/** What a caller without a serving weight can request instead, given what the values are per. */
function noServingAdvice(basisUnit: BasisUnit | undefined): string {
  switch (basisUnit) {
    case 'g':
      return 'Use an explicit mass-unit request with quantity and unit (g, oz, lb, kg).';
    case 'ml':
      return 'Values are per 100 ml; a mass-unit request (g, oz, lb, kg) is applied as millilitres without density conversion.';
    case undefined:
      return 'Values are per 100 label units (basis unverified); a mass-unit request (g, oz, lb, kg) is applied to that basis unconverted.';
  }
}

/** The amount a request resolved to, in the food's basis: `15g`, `15 ml`, or `15 IU label units`. Unescaped. */
function scaledAmount(
  amount: number,
  basisUnit: BasisUnit | undefined,
  servingSizeUnit: string | undefined,
): string {
  switch (basisUnit) {
    case 'g':
      return `${amount}g`;
    case 'ml':
      return `${amount} ml`;
    case undefined: {
      const unit = servingSizeUnit?.trim();
      return unit ? `${amount} ${unit} label units` : `${amount} label units`;
    }
  }
}

export const usdaGetFood = tool('usda_get_food', {
  title: 'Get USDA Food',
  description:
    'Get the full nutrient profile for one food by FDC ID. Returns all available nutrients (or a filtered subset via the nutrients[] param) with optional per-portion scaling. Use usda_search_foods to discover FDC IDs. Values are per 100 g (basisUnit "g"), except Branded foods FDC reports per 100 ml (basisUnit "ml") or per 100 of a label unit that fixes neither (basisUnit absent, basis unverified). Provide unit, optionally with quantity, to scale all nutrient values from that basis to that amount (e.g. quantity=200, unit="g" → per-200g values); a mass unit is applied to an ml or label-unit basis without conversion, and a notice says so. quantity defaults to 100 for g, oz, lb, and kg and to 1 for serving. Serving uses the first valid portion, or a positive finite Branded label size in g/GRM/GM (case-insensitive) when no portion exists; quantity multiplies that weight. A label in any other unit sets the basis rather than a serving weight, so it requires an explicit mass-unit request. quantity without unit is rejected. Narrow nutrients[] to specific IDs to reduce response size for focused queries.',
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
        'Filter to specific nutrient IDs (e.g. [1003, 1004, 1005, 1008] for protein, fat, carbs, energy). Use usda_list_nutrients to look up IDs. Omit to return all available nutrients. Requested IDs the food does not report are listed in missingNutrients.',
      ),
    quantity: z
      .number()
      .positive()
      .optional()
      .describe(
        'Amount of food, in unit, to scale nutrient values to. Must be positive. Requires unit. Defaults to 100 when unit is g, oz, lb, or kg, and to 1 when unit is "serving". Omit both quantity and unit for the per-100 values FDC reports (per 100 g, or per 100 ml when basisUnit is "ml").',
      ),
    unit: z
      .enum(['g', 'oz', 'lb', 'kg', 'serving'])
      .optional()
      .describe(
        'Unit for quantity. "serving" uses the first valid portion weight, or a Branded label size in g/GRM/GM (case-insensitive) when no portion exists, multiplied by quantity. Required when quantity is provided. Given alone, scales to 100 g, oz, lb, or kg, or to 1 serving.',
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
    basisUnit: z.enum(['g', 'ml']).optional().describe(BASIS_UNIT_DESCRIPTION),
    foodCategory: z
      .string()
      .optional()
      .describe(
        'USDA food category (e.g. "Poultry Products"): the food category for SR Legacy and Foundation, the label category for Branded, the WWEIA category for Survey (FNDDS). Absent when FDC reports none.',
      ),
    publicationDate: z.string().optional().describe('Date this food entry was published in FDC.'),
    brandOwner: z.string().optional().describe('Brand owner. Branded items only.'),
    brandName: z.string().optional().describe('Brand name. Branded items only.'),
    gtinUpc: z
      .string()
      .optional()
      .describe(
        'GTIN/UPC barcode as FDC stores it, leading zeros kept (e.g. "011110044174"). Branded items only.',
      ),
    ingredients: z.string().optional().describe('Ingredient list from label. Branded items only.'),
    servingSize: z
      .number()
      .optional()
      .describe('Serving size from the product label, in servingSizeUnit. Branded items only.'),
    servingSizeUnit: z
      .string()
      .optional()
      .describe(
        'Unit for servingSize as FDC reports it (e.g. "GRM", "MLT", "IU"); it sets basisUnit. Branded items only.',
      ),
    householdServingFullText: z
      .string()
      .optional()
      .describe('Serving as the label words it (e.g. "1 cup"). Branded items only.'),
    servingInfo: z
      .object({
        description: z
          .string()
          .describe(
            'Portion description: the Survey (FNDDS) portion text, or the amount, measure unit, and modifier (e.g. "0.5 cup"); for a Branded gram label, "Label serving:" with its size, unit, and household text.',
          ),
        gramWeight: z.number().describe('Gram weight of this portion.'),
        amount: z
          .number()
          .optional()
          .describe(
            'How many of the described unit gramWeight covers (0.5 for "0.5 cup"), when FDC sends one. Absent for Survey (FNDDS) portions, whose description carries the amount, and for a label serving.',
          ),
      })
      .optional()
      .describe(
        'First available portion definition, or a Branded gram-label serving identified in its description.',
      ),
    allPortions: z
      .array(
        z
          .object({
            description: z
              .string()
              .describe('Portion description (e.g. "0.5 cup", "1 small/regular").'),
            gramWeight: z.number().describe('Gram weight of this portion.'),
            amount: z
              .number()
              .optional()
              .describe(
                'How many of the described unit gramWeight covers (0.5 for "0.5 cup"), when FDC sends one. Absent for Survey (FNDDS) portions, whose description carries the amount.',
              ),
          })
          .describe('A named portion for this food.'),
      )
      .optional()
      .describe('All named portions for this food, in FDC order.'),
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
            'Amount resolved from quantity and unit (for serving, quantity × servingInfo.gramWeight); all nutrient values are per this many grams. With basisUnit "ml" it is applied as millilitres, and with no basisUnit as label units, without conversion.',
          ),
      })
      .optional()
      .describe('Scaling basis when unit was provided. Absent when returning per-100 values.'),
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
                'Nutrient amount — per 100 of basisUnit, or per scaledTo.gramWeight when unit is provided.',
              ),
            unit: z.string().describe('Measurement unit (e.g. "G", "MG", "KCAL").'),
            percentDailyValue: z
              .number()
              .optional()
              .describe('Percent daily value from product label. Branded items only.'),
          })
          .describe('A single nutrient entry with ID, name, amount, and unit.'),
      )
      .describe(
        'Nutrient values for this food, per 100 of basisUnit or scaled to the scaledTo basis.',
      ),
    missingNutrients: z
      .array(z.number())
      .optional()
      .describe(
        "Requested nutrient IDs this food's profile does not report, deduplicated, in request order. Absent when nutrients[] was omitted or every requested ID is present.",
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Basis caveat when a food not reported per 100 g is scaled: the resolved amount was applied to its per-100 ml or unverified label-unit basis without conversion.',
      ),
  },
  enrichmentTrailer: {
    // The notice can carry FDC's label unit, so content[] escapes it; structuredContent keeps it as sent.
    notice: {
      render: (notice) =>
        escapeMarkdownInline(notice ?? '')
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n'),
    },
  },

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
      when: 'unit="serving" was requested but the food has no valid portion or supported Branded gram-label serving.',
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
    let servingInfo = food.portions[0];
    if (
      !servingInfo &&
      food.dataType === 'Branded' &&
      food.servingSize != null &&
      Number.isFinite(food.servingSize) &&
      food.servingSize > 0 &&
      labelUnitBasis(food.servingSizeUnit) === 'g'
    ) {
      servingInfo = {
        description: `Label serving: ${food.servingSize} ${food.servingSizeUnit}${food.householdServingFullText ? ` (${food.householdServingFullText})` : ''}`,
        gramWeight: food.servingSize,
      };
    }
    let scaledTo: ScaledTo | undefined;
    let scaleFactor = 1;

    if (input.unit) {
      const quantity = input.quantity ?? (input.unit === 'serving' ? 1 : 100);
      let gramWeight: number;

      if (input.unit === 'serving') {
        if (!servingInfo) {
          throw ctx.fail(
            'no_portion_data',
            `Food "${food.description}" (ID ${food.fdcId}) has no portion data.`,
            {
              fdcId: food.fdcId,
              recovery: {
                hint: `No supported serving weight is available.${food.servingSize != null ? ` Label serving size: ${food.servingSize}.` : ''}${food.servingSizeUnit ? ` Label serving unit: ${food.servingSizeUnit}.` : ''} ${noServingAdvice(food.basisUnit)}`,
              },
            },
          );
        }
        gramWeight = quantity * servingInfo.gramWeight;
      } else {
        gramWeight = toGrams(quantity, input.unit);
      }

      // Same 4-decimal precision as nutrient amounts, so format() can render it verbatim
      gramWeight = Number(gramWeight.toFixed(4));
      scaleFactor = gramWeight / 100;
      scaledTo = { quantity, unit: input.unit, gramWeight };
      const notice = basisNotice(scaledTo, food.basisUnit, food.servingSizeUnit);
      if (notice) ctx.enrich.notice(notice);
    }

    return {
      fdcId: food.fdcId,
      description: food.description,
      dataType: food.dataType,
      ...(food.basisUnit && { basisUnit: food.basisUnit }),
      ...(food.foodCategory && { foodCategory: food.foodCategory }),
      ...(food.publicationDate && { publicationDate: food.publicationDate }),
      ...(food.brandOwner && { brandOwner: food.brandOwner }),
      ...(food.brandName && { brandName: food.brandName }),
      ...(food.gtinUpc && { gtinUpc: food.gtinUpc }),
      ...(food.ingredients && { ingredients: food.ingredients }),
      // JSON can carry an infinite size (1e400), which no number field accepts
      ...(food.servingSize != null &&
        Number.isFinite(food.servingSize) && { servingSize: food.servingSize }),
      ...(food.servingSizeUnit && { servingSizeUnit: food.servingSizeUnit }),
      ...(food.householdServingFullText && {
        householdServingFullText: food.householdServingFullText,
      }),
      ...(scaledTo && { scaledTo }),
      ...(servingInfo && { servingInfo }),
      ...(food.portions.length > 0 && {
        allPortions: food.portions,
      }),
      nutrients: food.nutrients.map((n) => ({
        ...n,
        amount: Number((n.amount * scaleFactor).toFixed(4)),
      })),
      ...(food.missingNutrients && { missingNutrients: food.missingNutrients }),
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
    if (result.gtinUpc) lines.push(`**GTIN/UPC:** ${escapeMarkdownInline(result.gtinUpc)}`);
    if (result.publicationDate) lines.push(`**Published:** ${result.publicationDate}`);
    if (result.ingredients) {
      lines.push(`**Ingredients:** ${escapeMarkdownInline(result.ingredients)}`);
    }

    if (result.scaledTo) {
      const amount = scaledAmount(
        result.scaledTo.gramWeight,
        result.basisUnit,
        result.servingSizeUnit,
      );
      lines.push(
        `\n**Basis:** ${result.scaledTo.quantity} ${result.scaledTo.unit} (${escapeMarkdownInline(amount)})`,
      );
    } else {
      lines.push(
        `\n**Basis:** ${escapeMarkdownInline(basisLabel(result.basisUnit, result.servingSizeUnit))}`,
      );
    }

    if (result.servingInfo) {
      const { amount } = result.servingInfo;
      lines.push(
        `**Serving:** ${escapeMarkdownInline(result.servingInfo.description)} = ${result.servingInfo.gramWeight}g${amount != null ? ` (amount: ${amount})` : ''}`,
      );
    }

    /**
     * servingInfo is the first portion whenever FDC sent portions, which
     * allPortions then lists; without them it can only be the gram label,
     * whose description already carries every label field.
     */
    const servingIsLabel = result.servingInfo != null && result.allPortions == null;
    const labelSize = [result.servingSize, result.servingSizeUnit]
      .filter((part) => part != null)
      .join(' ');
    const household = result.householdServingFullText;
    const label = labelSize && household ? `${labelSize} (${household})` : labelSize || household;
    if (label && !servingIsLabel) {
      lines.push(`**Label serving:** ${escapeMarkdownInline(label)}`);
    }

    if (result.allPortions && result.allPortions.length > 0) {
      lines.push(
        `**All portions:** ${result.allPortions.map((p) => `${escapeMarkdownInline(p.description)} (${p.gramWeight}g${p.amount != null ? `, amount: ${p.amount}` : ''})`).join(', ')}`,
      );
    }

    if (result.nutrients.length > 0) {
      lines.push('\n### Nutrients');
      for (const n of result.nutrients) {
        const pdv = n.percentDailyValue != null ? ` (${n.percentDailyValue}% DV)` : '';
        lines.push(
          `- **${escapeMarkdownInline(n.name)}** (ID: ${n.id}, SR#: ${n.number}): ${n.amount} ${n.unit}${pdv}`,
        );
      }
    } else if (!result.missingNutrients) {
      lines.push('\n**Nutrients:** none reported');
    }
    if (result.missingNutrients) {
      lines.push(
        `\n**Missing nutrients:** ${result.missingNutrients.join(', ')} (requested, not reported by this food)`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
