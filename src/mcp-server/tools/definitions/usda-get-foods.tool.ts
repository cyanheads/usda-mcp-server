/**
 * @fileoverview Batch nutrient profile fetch for multiple foods by FDC ID.
 * @module mcp-server/tools/definitions/usda-get-foods
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { createCounter, escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getLimitsConfig } from '@/config/server-config.js';
import {
  BASIS_UNIT_DESCRIPTION,
  basisLabel,
  LABEL_UNIT_DESCRIPTION,
} from '@/services/fdc/basis.js';
import { getFdcService } from '@/services/fdc/fdc-service.js';

/**
 * Distinct IDs fetched per call, in one `/foods` request. FDC accepts far more,
 * but a larger batch of full profiles nears the per-attempt timeout and
 * renders a response too large to use.
 */
const BATCH_SIZE = 20;

/** The most `fdcIds` entries a call accepts; distinct IDs past {@link BATCH_SIZE} are deferred. */
const MAX_ENTRIES = 500;

const deferrals = createCounter(
  'usda.batch.deferrals',
  'usda_get_foods calls that deferred distinct FDC IDs past the batch size',
  '{calls}',
);

/** Where the deferred IDs go next: usda_get_foods takes at least 2, so a single one is a usda_get_food call. */
function deferralNotice(distinct: number, deferredIds: number[]): string {
  const fetched = `Fetched the first ${BATCH_SIZE} of ${distinct} distinct FDC IDs`;
  return deferredIds.length === 1
    ? `${fetched}; fetch the 1 ID in deferredIds with usda_get_food (fdcId ${deferredIds[0]}).`
    : `${fetched}; call usda_get_foods again with the ${deferredIds.length} IDs in deferredIds.`;
}

export const usdaGetFoods = tool('usda_get_foods', {
  title: 'Get USDA Foods (Batch)',
  description:
    'Fetch nutrient profiles for several foods in one API call. More efficient than calling usda_get_food N times when you already have multiple FDC IDs. Accepts up to 500 IDs: repeats are dropped, the first 20 distinct IDs are fetched, and the rest are returned in deferredIds for a follow-up call. Values are per 100 of each food\'s basisUnit, with no portion scaling: per 100 g (basisUnit "g"), except Branded foods FDC reports per 100 ml (basisUnit "ml") or per 100 of a label unit that fixes neither (basisUnit absent, basis unverified). Use the nutrients[] filter to limit response size — strongly recommended for batch calls; requested IDs a food does not report are listed in its missingNutrients. For side-by-side comparison with a formatted table, use usda_compare_foods instead. Failed IDs (not found or no data) are reported in the failed[] array rather than aborting the entire batch.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    fdcIds: z
      .array(z.number().int().min(1))
      .min(2)
      .max(MAX_ENTRIES, {
        /**
         * Under USDA_CLAMP_LIMITS=false the bound a caller must meet is 20, so a call past 500
         * names 20 too; undefined keeps Zod's default. Config is read here, never at import.
         */
        error: () =>
          getLimitsConfig().clampLimits
            ? undefined
            : `Too big: expected array to have <=${BATCH_SIZE} items`,
      })
      // USDA_CLAMP_LIMITS=false keeps the 20-ID bound, raising the same issue a `.max(20)` would.
      .superRefine((fdcIds, refinement) => {
        if (fdcIds.length > BATCH_SIZE && !getLimitsConfig().clampLimits) {
          refinement.addIssue({
            code: 'too_big',
            maximum: BATCH_SIZE,
            origin: 'array',
            inclusive: true,
            input: fdcIds,
          });
        }
      })
      .describe(
        'FDC IDs to fetch — 2 to 500 entries (a server configured with strict limits rejects more than 20). Repeats are dropped; the first 20 distinct IDs are fetched and the rest are returned in deferredIds. Use usda_search_foods to discover IDs.',
      ),
    nutrients: z
      .array(z.number().int().min(1))
      .optional()
      .describe(
        'Filter to specific nutrient IDs (e.g. [1003, 1004, 1005, 1008]). Strongly recommended — full profiles can be large. Use usda_list_nutrients to look up IDs. Requested IDs a food does not report are listed in its missingNutrients.',
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
            basisUnit: z.enum(['g', 'ml']).optional().describe(BASIS_UNIT_DESCRIPTION),
            servingSizeUnit: z.string().optional().describe(LABEL_UNIT_DESCRIPTION),
            nutrients: z
              .array(
                z
                  .object({
                    id: z.number().describe('FDC nutrient ID.'),
                    name: z.string().describe('Nutrient name.'),
                    number: z.string().describe('SR reference number.'),
                    amount: z.number().describe('Amount per 100 of basisUnit.'),
                    unit: z.string().describe('Measurement unit (e.g. "G", "MG", "KCAL").'),
                  })
                  .describe('A nutrient entry with ID, name, amount, and unit.'),
              )
              .describe('Nutrient values per 100 of basisUnit.'),
            missingNutrients: z
              .array(z.number())
              .optional()
              .describe(
                "Requested nutrient IDs this food's profile does not report, deduplicated, in request order. Absent when nutrients[] was omitted or every requested ID is present.",
              ),
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
    deferredIds: z
      .array(z.number())
      .optional()
      .describe(
        'Distinct requested IDs past the first 20, in request order, not fetched by this call — foods and failed cover only the fetched IDs. Pass them to usda_get_foods again, or a single one to usda_get_food. Absent when every distinct ID was fetched.',
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Deferral notice when more than 20 distinct IDs were requested: how many were fetched, and the call that fetches the IDs in deferredIds.',
      ),
  },

  async handler(input, ctx) {
    const distinct = [...new Set(input.fdcIds)];
    const fetchIds = distinct.slice(0, BATCH_SIZE);
    const deferredIds = distinct.slice(BATCH_SIZE);
    ctx.log.info('Fetching batch foods', { count: fetchIds.length });

    const { foods, failed } = await getFdcService().getFoodsBatch(
      fetchIds,
      input.nutrients?.length ? input.nutrients : undefined,
      ctx,
    );

    ctx.log.info('Batch complete', { succeeded: foods.length, failed: failed.length });

    if (deferredIds.length > 0) {
      deferrals.add(1);
      ctx.log.notice('Deferred FDC IDs past the batch size', {
        requested: input.fdcIds.length,
        distinct: distinct.length,
        fetched: fetchIds.length,
        deferred: deferredIds.length,
      });
      ctx.enrich.notice(deferralNotice(distinct.length, deferredIds));
    }

    return {
      foods: foods.map((f) => ({
        fdcId: f.fdcId,
        description: f.description,
        dataType: f.dataType,
        ...(f.basisUnit && { basisUnit: f.basisUnit }),
        ...(f.servingSizeUnit && { servingSizeUnit: f.servingSizeUnit }),
        nutrients: f.nutrients.map((n) => ({
          id: n.id,
          name: n.name,
          number: n.number,
          amount: n.amount,
          unit: n.unit,
        })),
        ...(f.missingNutrients && { missingNutrients: f.missingNutrients }),
      })),
      failed,
      ...(deferredIds.length > 0 && { deferredIds }),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**${result.foods.length} foods fetched** | **${result.failed.length} failed**\n`,
    ];

    // FDC-supplied free text goes through escapeMarkdownInline so content[] reads back as written.
    for (const food of result.foods) {
      lines.push(`### ${escapeMarkdownInline(food.description)}`);
      const labelUnit = food.servingSizeUnit
        ? ` | **Label unit:** ${escapeMarkdownInline(food.servingSizeUnit)}`
        : '';
      lines.push(`**FDC ID:** ${food.fdcId} | **Type:** ${food.dataType}${labelUnit}`);
      const basis = escapeMarkdownInline(basisLabel(food.basisUnit, food.servingSizeUnit));
      if (food.nutrients.length > 0) {
        lines.push(`**Nutrients (${basis}):**`);
        for (const n of food.nutrients) {
          lines.push(
            `- ${escapeMarkdownInline(n.name)} (ID: ${n.id}, SR#: ${n.number}): ${n.amount} ${n.unit}`,
          );
        }
      } else {
        lines.push(`**Nutrients (${basis}):** none returned for this food.`);
      }
      if (food.missingNutrients) {
        lines.push(`**Missing nutrients:** ${food.missingNutrients.join(', ')}`);
      }
      lines.push('');
    }

    if (result.failed.length > 0) {
      lines.push('### Failed IDs');
      for (const f of result.failed) {
        lines.push(`- FDC ID ${f.fdcId}: ${escapeMarkdownInline(f.error)}`);
      }
    }

    if (result.deferredIds) {
      lines.push(`\n**Deferred (not fetched):** ${result.deferredIds.join(', ')}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
