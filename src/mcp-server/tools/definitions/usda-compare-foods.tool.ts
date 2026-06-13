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

export const usdaCompareFoods = tool('usda_compare_foods', {
  title: 'Compare USDA Foods',
  description:
    'Compare nutrients side-by-side for 2–5 foods. Returns a structured table — one row per nutrient, one column per food — formatted as markdown. Best for "spinach vs kale iron" or "which has more protein?" questions. Omit nutrients[] to use the 12 most common defaults (energy, protein, fat, saturated fat, carbs, fiber, sugars, sodium, potassium, calcium, iron, vitamin C); provide nutrients[] with specific FDC IDs to compare different nutrients. All values are scaled to the same gram basis (default 100g). If one or more FDC IDs are not found, the comparison proceeds with the valid foods — only throws too_few_foods when fewer than 2 IDs return data.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    fdcIds: z
      .array(z.number().int().min(1))
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
      .positive()
      .default(100)
      .describe(
        'Gram basis for comparison. All values scaled to this amount. Must be positive. Default 100.',
      ),
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
        quantity: z.number().describe('Numeric quantity provided in the request.'),
        unit: z.string().describe('Unit provided in the request (g, oz, lb, or kg).'),
        gramWeight: z
          .number()
          .describe(
            'Gram weight resolved from quantity+unit — all nutrient values are per this many grams.',
          ),
      })
      .describe('The common scaling basis applied to all nutrient values.'),
    foods: z
      .array(
        z
          .object({
            fdcId: z.number().describe('FDC ID.'),
            description: z.string().describe('Full USDA food name (e.g. "Spinach, raw").'),
            dataType: z
              .string()
              .describe('FDC data source: SR Legacy, Foundation, Survey (FNDDS), or Branded.'),
          })
          .describe('One of the compared foods.'),
      )
      .describe('The compared foods, in the same order as the values arrays below.'),
    nutrients: z
      .array(
        z
          .object({
            id: z.number().describe('FDC nutrient ID.'),
            name: z.string().describe('Nutrient name (e.g. "Protein", "Energy").'),
            unit: z.string().describe('Measurement unit (e.g. "G", "MG", "KCAL").'),
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
      code: JsonRpcErrorCode.ValidationError,
      when: 'Fewer than 2 of the provided FDC IDs returned data, making comparison impossible.',
      recovery: 'Verify IDs using usda_search_foods and provide at least 2 valid FDC IDs.',
    },
  ],

  async handler(input, ctx) {
    const nutrientIds = input.nutrients?.length ? input.nutrients : DEFAULT_COMPARE_NUTRIENTS;
    ctx.log.info('Comparing foods', { fdcIds: input.fdcIds, nutrientCount: nutrientIds.length });

    const gramWeight = toGrams(input.quantity, input.unit);
    const scaleFactor = gramWeight / 100;

    const { foods: rawFoods, failed } = await getFdcService().getFoodsBatch(
      input.fdcIds,
      nutrientIds,
      ctx,
    );

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

    const missingData: Array<{ fdcId: number; nutrientId: number | null }> = failed.map((f) => ({
      fdcId: f.fdcId,
      nutrientId: null,
    }));

    // Pivot: nutrient × food — resolve name/unit from whichever food has it
    const nutrientRows = nutrientIds.map((nid) => {
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

    const nutrientRowsFiltered = nutrientRows.filter((r) => r.values.some((v) => v !== null));

    return {
      basis: { quantity: input.quantity, unit: input.unit, gramWeight },
      foods,
      nutrients: nutrientRowsFiltered,
      ...(missingData.length > 0 && { missingData }),
    };
  },

  format: (result) => {
    const lines: string[] = [];

    lines.push(
      `**Basis:** ${result.basis.quantity} ${result.basis.unit} (${result.basis.gramWeight.toFixed(1)}g)\n`,
    );

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

    // format-parity: structuredContent carries the foods array, text must too
    lines.push('\n**Compared foods:**');
    for (const f of result.foods) {
      lines.push(`- **${f.description}** (FDC ID: ${f.fdcId}, type: ${f.dataType})`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
