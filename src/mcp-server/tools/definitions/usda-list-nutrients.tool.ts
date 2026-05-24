/**
 * @fileoverview Returns the FDC nutrient reference table — all tracked nutrients with IDs, names, and units.
 * @module mcp-server/tools/definitions/usda-list-nutrients
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getNutrientsByCategory } from '@/services/fdc/nutrient-reference.js';

export const usdaListNutrients = tool('usda_list_nutrients', {
  title: 'List USDA Nutrients',
  description:
    'Returns the FDC nutrient reference table — all tracked nutrients with their numeric IDs, names, SR reference numbers, units, and categories. Use this to resolve a nutrient name (e.g. "vitamin C") to its FDC ID (1162) before passing it to the nutrients[] filter on other tools. Optionally filter by category: macronutrients, vitamins, minerals, lipids, amino_acids, or other. The data is stable — call once and reuse the IDs.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    category: z
      .enum(['macronutrients', 'vitamins', 'minerals', 'lipids', 'amino_acids', 'other'])
      .optional()
      .describe(
        'Filter to a nutrient category. Omit to return all ~150 tracked nutrients. Options: macronutrients, vitamins, minerals, lipids, amino_acids, other.',
      ),
  }),
  output: z.object({
    nutrients: z
      .array(
        z
          .object({
            id: z
              .number()
              .describe('FDC nutrient ID — pass this to nutrients[] params on other tools.'),
            name: z.string().describe('Human-readable nutrient name (e.g. "Protein", "Iron, Fe").'),
            number: z.string().describe('SR reference number (legacy identifier, e.g. "203").'),
            unit: z.string().describe('Measurement unit (e.g. "G", "MG", "UG", "KCAL").'),
            category: z.string().describe('Nutrient category grouping.'),
          })
          .describe('A nutrient reference entry with ID, name, unit, and category.'),
      )
      .describe(
        'Nutrient reference entries matching the requested category, or all if category is omitted.',
      ),
  }),

  // biome-ignore lint/suspicious/useAwait: framework requires async handler signature
  async handler(input, ctx) {
    const nutrients = getNutrientsByCategory(input.category);
    ctx.log.info('Listing nutrients', {
      category: input.category ?? 'all',
      count: nutrients.length,
    });
    return { nutrients };
  },

  format: (result) => {
    const lines: string[] = [`**${result.nutrients.length} nutrients**\n`];
    for (const n of result.nutrients) {
      lines.push(
        `**${n.name}** (ID: ${n.id}) | Unit: ${n.unit} | SR#: ${n.number} | Category: ${n.category}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
