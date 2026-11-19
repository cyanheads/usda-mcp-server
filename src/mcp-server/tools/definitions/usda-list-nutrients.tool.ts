/**
 * @fileoverview Returns rows of the FDC nutrient reference table, filtered by category and by name, ID, or SR number.
 * @module mcp-server/tools/definitions/usda-list-nutrients
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { NUTRIENT_REFERENCE } from '@/services/fdc/nutrient-reference.js';

const TOTAL = NUTRIENT_REFERENCE.length;

export const usdaListNutrients = tool('usda_list_nutrients', {
  title: 'List USDA Nutrients',
  description: `Look up the FDC nutrient reference table — ${TOTAL} nutrients with their numeric IDs, names, SR reference numbers, units, and categories. Use to resolve a nutrient name (e.g. "vitamin C") to its FDC ID (1162) before passing it to the nutrients[] filter on other tools. Pass query to match a name, ID, or SR number, and category (macronutrients, vitamins, minerals, lipids, amino_acids, or other) to narrow to one group. The data is static — call once and reuse the IDs.`,
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    category: z
      .enum(['macronutrients', 'vitamins', 'minerals', 'lipids', 'amino_acids', 'other'])
      .optional()
      .describe(
        `Filter to a nutrient category. Options: macronutrients, vitamins, minerals, lipids, amino_acids, other. Omit both category and query to list all ${TOTAL} tracked nutrients.`,
      ),
    query: z
      .string()
      .optional()
      .describe(
        'Part of a nutrient name, matched case-insensitively (e.g. "lutein", "18:1"), or a whole FDC nutrient ID ("1062") or SR number ("268"). Combines with category. A blank query is ignored.',
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
            number: z
              .string()
              .describe(
                'SR reference number (legacy identifier, e.g. "203"); empty when FDC assigns none.',
              ),
            unit: z.string().describe('Measurement unit (e.g. "G", "MG", "UG", "KCAL").'),
            category: z.string().describe('Nutrient category grouping.'),
          })
          .describe('A nutrient reference entry with ID, name, unit, and category.'),
      )
      .describe(
        'Nutrient reference entries matching category and query, or the whole table when both are omitted. Grouped by category, in FDC rank order within each.',
      ),
  }),
  enrichment: {
    effectiveQuery: z
      .string()
      .optional()
      .describe('The trimmed query, echoed when no nutrient matches it.'),
    notice: z
      .string()
      .optional()
      .describe('Present when no nutrient matches the filters: what to try instead.'),
  },

  // biome-ignore lint/suspicious/useAwait: framework requires async handler signature
  async handler(input, ctx) {
    const { category } = input;
    const query = input.query?.trim();
    let nutrients = category
      ? NUTRIENT_REFERENCE.filter((n) => n.category === category)
      : NUTRIENT_REFERENCE;
    if (query) {
      const needle = query.toLowerCase();
      nutrients = nutrients.filter(
        (n) =>
          n.name.toLowerCase().includes(needle) || String(n.id) === query || n.number === query,
      );
      // Every category holds rows, so only a query can match nothing.
      if (nutrients.length === 0) {
        /**
         * The query goes out through echo, which renders it as a code literal in
         * content[] and raw in structuredContent; the notice is authored
         * Markdown, so it never embeds the caller's text.
         */
        ctx.enrich.echo(query);
        ctx.enrich.notice(
          category
            ? `No nutrient in category ${category} matches this query. Names follow FDC's spelling (e.g. "Vitamin B-12", "PUFA 22:6 n-3 (DHA)"): try a shorter term or drop category, or omit both to list all ${TOTAL} nutrients.`
            : `No nutrient matches this query. Names follow FDC's spelling (e.g. "Vitamin B-12", "PUFA 22:6 n-3 (DHA)"): try a shorter term, or omit query to list all ${TOTAL} nutrients.`,
        );
      }
    }
    ctx.log.info('Listing nutrients', {
      category: category ?? 'all',
      count: nutrients.length,
    });
    return { nutrients };
  },

  format: (result) => {
    const count = result.nutrients.length;
    const lines: string[] = [`**${count} ${count === 1 ? 'nutrient' : 'nutrients'}**\n`];
    for (const n of result.nutrients) {
      // FDC assigns some nutrients no SR number; an empty one is left out rather than shown blank.
      const number = n.number ? ` | SR#: ${n.number}` : '';
      lines.push(
        `**${escapeMarkdownInline(n.name)}** (ID: ${n.id}) | Unit: ${n.unit}${number} | Category: ${n.category}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
