/**
 * @fileoverview Side-by-side nutrient comparison for 2–5 foods, formatted as a markdown table.
 * @module mcp-server/tools/definitions/usda-compare-foods
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getFdcService } from '@/services/fdc/fdc-service.js';

/** Default nutrient IDs for comparison when none are specified. */
const DEFAULT_COMPARE_NUTRIENTS = [
  1008, // Energy
  1003, // Protein
  1004, // Total fat
  1258, // Saturated fat
  1005, // Carbohydrate
  1079, // Fiber
  1063, // Sugars
  1093, // Sodium
  1092, // Potassium
  1087, // Calcium
  1089, // Iron
  1162, // Vitamin C
];

/** Convert quantity in a unit to grams. */
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
      return quantity;
  }
}

export const usdaCompareFoods = tool('usda_compare_foods', {
  title: 'Compare USDA Foods',
  description:
    'Side-by-side nutrient comparison for 2–5 foods. Returns a structured table — one row per nutrient, one column per food — and formats it as a markdown table. Best for "spinach vs kale iron" or "which has more protein?" questions. Pass the default nutrients to get the 12 most commonly compared; provide nutrients[] for specific nutrients. All values are scaled to the same gram basis (default 100g). If one or more FDC IDs are not found, the comparison proceeds with valid foods — only throws too_few_foods when fewer than 2 IDs return data.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    fdcIds: z
      .array(z.number().int())
      .min(2)
      .max(5)
      .describe('FDC IDs to compare — 2 to 5 foods. Use usda_search_foods to discover IDs.'),
    nutrients: z
      .array(z.number().int())
      .optional()
      .describe(
        'Nutrient IDs to include in the comparison. Defaults to the 12 most common: energy (1008), protein (1003), total fat (1004), saturated fat (1258), carbohydrate (1005), fiber (1079), sugars (1063), sodium (1093), potassium (1092), calcium (1087), iron (1089), vitamin C (1162). Use usda_list_nutrients to look up other IDs.',
      ),
    quantity: z
      .number()
      .default(100)
      .describe('Gram basis for comparison. All values scaled to this amount. Default 100.'),
    unit: z
      .enum(['g', 'oz', 'lb', 'kg'])
      .default('g')
      .describe(
        'Unit for quantity. Default "g". Does not support "serving" (use a fixed gram basis for consistent comparison).',
      ),
  }),
  output: z.object({
    basis: z
      .object({
        quantity: z.number().describe('The quantity value used for scaling.'),
        unit: z.string().describe('The unit used for scaling.'),
        gramWeight: z.number().describe('Resolved gram weight used for all values.'),
      })
      .describe('The common scaling basis applied to all nutrient values.'),
    foods: z
      .array(
        z
          .object({
            fdcId: z.number().describe('FDC ID.'),
            description: z.string().describe('USDA food description.'),
            dataType: z.string().describe('FDC data source.'),
          })
          .describe('One of the compared foods.'),
      )
      .describe('The compared foods, in the same order as the values arrays below.'),
    nutrients: z
      .array(
        z
          .object({
            id: z.number().describe('FDC nutrient ID.'),
            name: z.string().describe('Nutrient name.'),
            unit: z.string().describe('Measurement unit.'),
            values: z
              .array(z.number().nullable())
              .describe(
                'One value per food in the same order as foods[]. null when data is unavailable for that food.',
              ),
          })
          .describe('One nutrient row with per-food values.'),
      )
      .describe(
        'Nutrient rows — one entry per requested nutrient, with per-food values in the values[] array.',
      ),
    missingData: z
      .array(
        z
          .object({
            fdcId: z.number().describe('FDC ID that had missing data.'),
            nutrientId: z
              .number()
              .nullable()
              .describe(
                'Nutrient ID that was missing, or null when the entire food was not found.',
              ),
          })
          .describe('A food or food+nutrient pair where data was unavailable.'),
      )
      .optional()
      .describe(
        'Foods or food+nutrient pairs where data was unavailable. Absent when all data was present.',
      ),
  }),

  errors: [
    {
      reason: 'too_few_foods',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Fewer than 2 of the provided FDC IDs returned data, making comparison impossible.',
      recovery: 'Verify IDs using usda_search_foods and provide at least 2 valid FDC IDs.',
    },
  ],

  async handler(input, ctx) {
    const nutrientIds = input.nutrients?.length ? input.nutrients : DEFAULT_COMPARE_NUTRIENTS;
    ctx.log.info('Comparing foods', { fdcIds: input.fdcIds, nutrientCount: nutrientIds.length });

    const gramWeight = toGrams(input.quantity, input.unit);
    const scaleFactor = gramWeight / 100;

    // Batch fetch all foods
    const { foods: rawFoods, failed } = await getFdcService().getFoodsBatch(
      input.fdcIds,
      nutrientIds,
      ctx,
    );

    // Need at least 2 valid foods
    if (rawFoods.length < 2) {
      throw ctx.fail(
        'too_few_foods',
        `Only ${rawFoods.length} of ${input.fdcIds.length} FDC IDs returned data.`,
        { fdcIds: input.fdcIds, ...ctx.recoveryFor('too_few_foods') },
      );
    }

    const foods = rawFoods.map((f) => ({
      fdcId: f.fdcId,
      description: f.description,
      dataType: f.dataType,
    }));

    // Track missing data
    const missingData: Array<{ fdcId: number; nutrientId: number | null }> = failed.map((f) => ({
      fdcId: f.fdcId,
      nutrientId: null,
    }));

    // Build nutrient rows — pivot (nutrient × food)
    const nutrientRows = nutrientIds.map((nid) => {
      // Find nutrient name/unit from first food that has it
      let name = `Nutrient ${nid}`;
      let unit = '';
      for (const food of rawFoods) {
        const n = food.nutrients.find((x) => x.id === nid);
        if (n) {
          name = n.name;
          unit = n.unit;
          break;
        }
      }

      const values = rawFoods.map((food) => {
        const n = food.nutrients.find((x) => x.id === nid);
        if (n == null) {
          missingData.push({ fdcId: food.fdcId, nutrientId: nid });
          return null;
        }
        return Number((n.amount * scaleFactor).toFixed(4));
      });

      return { id: nid, name, unit, values };
    });

    // Filter out nutrients where all values are null
    const nutrientRowsFiltered = nutrientRows.filter((r) => r.values.some((v) => v !== null));

    const result: {
      basis: { quantity: number; unit: string; gramWeight: number };
      foods: Array<{ fdcId: number; description: string; dataType: string }>;
      nutrients: Array<{ id: number; name: string; unit: string; values: (number | null)[] }>;
      missingData?: Array<{ fdcId: number; nutrientId: number | null }>;
    } = {
      basis: { quantity: input.quantity, unit: input.unit, gramWeight },
      foods,
      nutrients: nutrientRowsFiltered,
    };

    if (missingData.length > 0) {
      result.missingData = missingData;
    }

    return result;
  },

  format: (result) => {
    const lines: string[] = [];

    lines.push(
      `**Basis:** ${result.basis.quantity} ${result.basis.unit} (${result.basis.gramWeight.toFixed(1)}g)\n`,
    );

    // Markdown table: header row
    const foodHeaders = result.foods.map((f) => f.description).join(' | ');
    lines.push(`| Nutrient | ${foodHeaders} |`);
    lines.push(`| --- | ${result.foods.map(() => '---').join(' | ')} |`);

    for (const row of result.nutrients) {
      const cells = row.values.map((v) => (v === null ? '—' : String(v)));
      lines.push(`| ${row.name} (${row.unit}) [ID:${row.id}] | ${cells.join(' | ')} |`);
    }

    if (result.missingData && result.missingData.length > 0) {
      lines.push('\n**Missing data:**');
      const notFound = result.missingData.filter((m) => m.nutrientId === null);
      const missingNutrients = result.missingData.filter(
        (m): m is { fdcId: number; nutrientId: number } => m.nutrientId !== null,
      );
      if (notFound.length > 0) {
        lines.push(`- Not found: FDC IDs ${notFound.map((m) => m.fdcId).join(', ')}`);
      }
      if (missingNutrients.length > 0) {
        const grouped = new Map<number, number[]>();
        for (const m of missingNutrients) {
          const list = grouped.get(m.fdcId) ?? [];
          list.push(m.nutrientId);
          grouped.set(m.fdcId, list);
        }
        for (const [fdcId, nids] of grouped) {
          lines.push(`- FDC ID ${fdcId}: missing nutrients ${nids.join(', ')}`);
        }
      }
    }

    // Also include foods/fdcIds in the text so format-parity is satisfied
    lines.push('\n**Compared foods:**');
    for (const f of result.foods) {
      lines.push(`- **${f.description}** (FDC ID: ${f.fdcId}, type: ${f.dataType})`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
