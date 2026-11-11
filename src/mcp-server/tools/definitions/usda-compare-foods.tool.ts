/**
 * @fileoverview Side-by-side nutrient comparison for 2–5 foods, formatted as a markdown table.
 * @module mcp-server/tools/definitions/usda-compare-foods
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import {
  BASIS_UNIT_DESCRIPTION,
  type BasisUnit,
  basisLabel,
  LABEL_UNIT_DESCRIPTION,
} from '@/services/fdc/basis.js';
import { getFdcService } from '@/services/fdc/fdc-service.js';
import { NUTRIENT_BY_ID } from '@/services/fdc/nutrient-reference.js';
import type { FoodDetail, FoodNutrient } from '@/services/fdc/types.js';

/** Default nutrient IDs for comparison when none are specified. */
const DEFAULT_COMPARE_NUTRIENTS = [
  1008, // Energy
  1003, // Protein
  1004, // Total fat
  1258, // Saturated fat
  1005, // Carbohydrate
  1079, // Fiber
  2000, // Total Sugars — not 1063 "Sugars, Total", which only Foundation foods report
  1093, // Sodium
  1092, // Potassium
  1087, // Calcium
  1089, // Iron
  1162, // Vitamin C
];

/**
 * The equivalent nutrients a default row falls back to, in order, for a food
 * that does not report the row's ID. Foundation records report energy as the
 * Atwater estimates 2048 (specific factors, the method behind SR Legacy's
 * 1008) and 2047 (general factors, 4-9-4), and sugars as 1063 rather than
 * 2000. An explicit nutrients[] is never filled.
 */
const DEFAULT_FILLS = new Map<number, readonly number[]>([
  [1008, [2048, 2047]],
  [2000, [1063]],
]);

/** The default rows and their fill sources: the service filters profiles locally, so a source left out never arrives. */
const DEFAULT_FETCH_NUTRIENTS = [
  ...DEFAULT_COMPARE_NUTRIENTS,
  ...[...DEFAULT_FILLS.values()].flat(),
];

/** The first of `ids` the food reports, tried in order. */
function firstReported(food: FoodDetail, ids: readonly number[]): FoodNutrient | undefined {
  for (const id of ids) {
    const found = food.nutrients.find((n) => n.id === id);
    if (found) return found;
  }
  return;
}

/**
 * The caveat for a compared food not reported per 100 g: an ml food's column
 * is per `gramWeight` millilitres, and a label unit that fixes neither leaves
 * the basis unverified. Undefined for a per-100 g food.
 */
function basisCaveat(
  fdcId: number,
  basisUnit: BasisUnit | undefined,
  servingSizeUnit: string | undefined,
  gramWeight: number,
): string | undefined {
  switch (basisUnit) {
    case 'g':
      return;
    case 'ml':
      return `FDC ID ${fdcId} reports values per 100 ml; its column is per ${gramWeight} ml, compared without density conversion.`;
    case undefined: {
      const unit = servingSizeUnit?.trim();
      return `FDC ID ${fdcId} has an unverified per-100 basis (${unit ? `label unit ${unit}` : 'no label unit'}).`;
    }
  }
}

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
    'Compare nutrients side-by-side for 2–5 foods. Returns a structured table — one row per nutrient, one column per food — formatted as markdown. Best for "spinach vs kale iron" or "which has more protein?" questions. Omit nutrients[] to use the 12 most common defaults (energy, protein, fat, saturated fat, carbs, fiber, sugars, sodium, potassium, calcium, iron, vitamin C); a food that lacks the default energy (1008) or total sugars (2000) value has that cell filled from its equivalent nutrient — energy from 2048, then 2047; sugars from 1063 — and each fill is listed in substitutions. Provide nutrients[] with specific FDC IDs to compare different nutrients; an explicit list is compared as given, without fills. All values are scaled to the same basis, quantity in unit: default 100 g, so unit="oz" alone compares per 100 oz and quantity alone is grams. A Branded food FDC reports per 100 ml (basisUnit "ml") or per 100 of a label unit that fixes neither (basisUnit absent) is compared on that basis without conversion, and a notice names it. If one or more FDC IDs are not found, the comparison proceeds with the valid foods — only throws too_few_foods when fewer than 2 IDs return data.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    fdcIds: z
      .array(z.number().int().min(1))
      .min(2)
      .max(5)
      .describe('FDC IDs to compare — 2 to 5 foods. Use usda_search_foods to discover IDs.'),
    nutrients: z
      .array(z.number().int().min(1))
      .optional()
      .describe(
        'Nutrient IDs to include in the comparison. Defaults to the 12 most common: energy (1008), protein (1003), total fat (1004), saturated fat (1258), carbohydrate (1005), fiber (1079), total sugars (2000), sodium (1093), potassium (1092), calcium (1087), iron (1089), vitamin C (1162). Under the defaults, a food missing energy or total sugars has that cell filled from its equivalent nutrient (listed in substitutions); IDs given here are compared as given. Use usda_list_nutrients to look up other IDs.',
      ),
    quantity: z
      .number()
      .positive()
      .default(100)
      .describe(
        'Amount of food, in unit, that every value is scaled to. Must be positive. Default 100.',
      ),
    unit: z
      .enum(['g', 'oz', 'lb', 'kg'])
      .default('g')
      .describe(
        'Unit for quantity. Default "g". Does not support "serving" (each food\'s portion weight differs, so a serving basis would not compare equal amounts).',
      ),
  }),
  output: z.object({
    basis: z
      .object({
        quantity: z
          .number()
          .describe('Quantity applied, in unit — the requested value or the default 100.'),
        unit: z
          .string()
          .describe('Unit applied (g, oz, lb, or kg) — the requested value or the default "g".'),
        gramWeight: z
          .number()
          .describe(
            'Gram weight resolved from quantity and unit — every column is per this many grams, except that a food with basisUnit "ml" is per this many millilitres and one with no basisUnit per this many label units, compared without conversion.',
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
            basisUnit: z.enum(['g', 'ml']).optional().describe(BASIS_UNIT_DESCRIPTION),
            servingSizeUnit: z.string().optional().describe(LABEL_UNIT_DESCRIPTION),
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
        'Foods or food+nutrient pairs where data was unavailable. A cell filled from an equivalent nutrient is listed in substitutions, not here. Absent when all data was present.',
      ),
    substitutions: z
      .array(
        z
          .object({
            fdcId: z.number().describe('FDC ID of the food whose cell was filled.'),
            requested: z
              .number()
              .describe('Nutrient ID of the row: 1008 (energy) or 2000 (total sugars).'),
            used: z
              .number()
              .describe(
                'Nutrient ID the value was taken from: 2048 or 2047 for energy, 1063 for sugars.',
              ),
          })
          .describe('One default-row cell filled from an equivalent nutrient.'),
      )
      .optional()
      .describe(
        'Default-row cells filled from an equivalent nutrient because the food does not report the row ID, in nutrients[] then foods[] order. Absent when nothing was filled.',
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Basis caveat naming each compared food not reported per 100 g: an ml food compared per basis.gramWeight millilitres, or a food whose per-100 basis is unverified, both without conversion.',
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
      reason: 'too_few_foods',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Fewer than 2 of the provided FDC IDs returned data, making comparison impossible.',
      recovery: 'Verify IDs using usda_search_foods and provide at least 2 valid FDC IDs.',
      severity: 'notice',
    },
  ],

  async handler(input, ctx) {
    const explicit = input.nutrients?.length ? input.nutrients : undefined;
    const nutrientIds = explicit ?? DEFAULT_COMPARE_NUTRIENTS;
    ctx.log.info('Comparing foods', { fdcIds: input.fdcIds, nutrientCount: nutrientIds.length });

    // Same 4-decimal precision as nutrient values, so format() can render it verbatim
    const gramWeight = Number(toGrams(input.quantity, input.unit).toFixed(4));
    const scaleFactor = gramWeight / 100;

    const { foods: rawFoods, failed } = await getFdcService().getFoodsBatch(
      input.fdcIds,
      explicit ?? DEFAULT_FETCH_NUTRIENTS,
      ctx,
    );

    if (rawFoods.length < 2) {
      throw ctx.fail(
        'too_few_foods',
        `Only ${rawFoods.length} of ${input.fdcIds.length} FDC IDs returned data.`,
        { fdcIds: input.fdcIds },
      );
    }

    const foods = rawFoods.map((f) => ({
      fdcId: f.fdcId,
      description: f.description,
      dataType: f.dataType,
      ...(f.basisUnit && { basisUnit: f.basisUnit }),
      ...(f.servingSizeUnit && { servingSizeUnit: f.servingSizeUnit }),
    }));

    const missingData: Array<{ fdcId: number; nutrientId: number | null }> = failed.map((f) => ({
      fdcId: f.fdcId,
      nutrientId: null,
    }));
    const substitutions: Array<{ fdcId: number; requested: number; used: number }> = [];

    // Pivot: nutrient × food, each cell the requested ID or, on a default row, its first equivalent the food reports
    const nutrientRows = nutrientIds.map((nid) => {
      const fills = explicit ? [] : (DEFAULT_FILLS.get(nid) ?? []);
      const lookup = [nid, ...fills];
      const values = rawFoods.map((food) => {
        const n = firstReported(food, lookup);
        if (n === undefined) {
          missingData.push({ fdcId: food.fdcId, nutrientId: nid });
          return null;
        }
        if (n.id !== nid) substitutions.push({ fdcId: food.fdcId, requested: nid, used: n.id });
        return Number((n.amount * scaleFactor).toFixed(4));
      });

      // Named for the requested ID — the first food reporting it, else the reference — never for a fill source
      const named =
        rawFoods.map((food) => firstReported(food, [nid])).find((n) => n !== undefined) ??
        NUTRIENT_BY_ID.get(nid);
      return { id: nid, name: named?.name ?? `Nutrient ${nid}`, unit: named?.unit ?? '', values };
    });

    const nutrientRowsFiltered = nutrientRows.filter((r) => r.values.some((v) => v !== null));

    const caveats = rawFoods.flatMap(
      (f) => basisCaveat(f.fdcId, f.basisUnit, f.servingSizeUnit, gramWeight) ?? [],
    );
    if (caveats.length > 0) ctx.enrich.notice(caveats.join(' '));

    return {
      basis: { quantity: input.quantity, unit: input.unit, gramWeight },
      foods,
      nutrients: nutrientRowsFiltered,
      ...(missingData.length > 0 && { missingData }),
      ...(substitutions.length > 0 && { substitutions }),
    };
  },

  format: (result) => {
    const lines: string[] = [];

    lines.push(
      `**Basis:** ${result.basis.quantity} ${result.basis.unit} (${result.basis.gramWeight}g)\n`,
    );

    // FDC-supplied free text goes through escapeMarkdownInline, which also escapes `|` inside table cells.
    const foodHeaders = result.foods
      .map((f) => `${escapeMarkdownInline(f.description)} (${f.fdcId})`)
      .join(' | ');
    lines.push(`| Nutrient | ${foodHeaders} |`);
    lines.push(`| --- | ${result.foods.map(() => '---').join(' | ')} |`);

    for (const row of result.nutrients) {
      const cells = row.values.map((v) => (v === null ? '—' : String(v)));
      lines.push(
        `| ${escapeMarkdownInline(row.name)} (${row.unit}) [ID:${row.id}] | ${cells.join(' | ')} |`,
      );
    }

    if (result.substitutions) {
      lines.push('\n**Filled from equivalent nutrients:**');
      for (const s of result.substitutions) {
        lines.push(`- FDC ID ${s.fdcId}: nutrient ${s.requested} filled from ${s.used}`);
      }
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
      const labelUnit = f.servingSizeUnit
        ? `, label unit: ${escapeMarkdownInline(f.servingSizeUnit)}`
        : '';
      const basis = escapeMarkdownInline(basisLabel(f.basisUnit, f.servingSizeUnit));
      lines.push(
        `- **${escapeMarkdownInline(f.description)}** (FDC ID: ${f.fdcId}, type: ${f.dataType}${labelUnit}, basis: ${basis})`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
