/**
 * @fileoverview Batch nutrient profile fetch for multiple foods by FDC ID.
 * @module mcp-server/tools/definitions/usda-get-foods
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createCounter, escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { fdcIdList } from '@/mcp-server/tools/fdc-id-list.js';
import {
  BASIS_UNIT_DESCRIPTION,
  basisLabel,
  LABEL_UNIT_DESCRIPTION,
} from '@/services/fdc/basis.js';
import { getFdcService } from '@/services/fdc/fdc-service.js';
import { NUTRIENT_PROVENANCE_OUTPUT, provenanceText } from '@/services/fdc/provenance.js';

/**
 * Distinct IDs fetched per call, sent together as one `/foods` request (split
 * one ID per request only when that request runs out of time). FDC accepts far
 * more, but a larger batch of full profiles nears the per-attempt timeout and
 * renders a response too large to use.
 */
const BATCH_SIZE = 20;

const deferrals = createCounter(
  'usda.batch.deferrals',
  'usda_get_foods calls that deferred distinct FDC IDs past the batch size',
  '{calls}',
);

/**
 * What `deferredIds` holds and where it goes next: the fetched IDs FDC did not
 * return before the call's deadline or kept failing on (`unanswered`), then
 * those past {@link BATCH_SIZE}. The follow-up carries the same nutrients and
 * provenance, so it returns what this call would have. usda_get_foods takes at
 * least 2 IDs, so a single one is a usda_get_food call, which also gives one
 * slow record the whole budget.
 */
function deferralNotice(
  distinct: number,
  fetched: number,
  unanswered: number[],
  deferredIds: number[],
): string {
  const pastBatch = `Fetched the first ${BATCH_SIZE} of ${distinct} distinct FDC IDs`;
  const n = unanswered.length;
  let lead = pastBatch;
  if (n > 0) {
    const late = `(${unanswered.join(', ')}) went unanswered: FDC did not return ${n === 1 ? 'it' : 'them'} before this call's deadline or kept failing`;
    lead =
      distinct > BATCH_SIZE
        ? `${pastBatch}, and ${n} of those ${late}`
        : `${n} of the ${fetched} fetched FDC IDs ${late}`;
  }
  if (deferredIds.length === 1) {
    return `${lead}; fetch the 1 ID in deferredIds with usda_get_food (fdcId ${deferredIds[0]}) and the same nutrients and provenance.`;
  }
  const oneByOne =
    n === 0
      ? ''
      : `, or fetch ${n === deferredIds.length ? 'them' : 'the unanswered ones'} one at a time with usda_get_food`;
  return `${lead}; call usda_get_foods again with the ${deferredIds.length} IDs in deferredIds and the same nutrients and provenance${oneByOne}.`;
}

export const usdaGetFoods = tool('usda_get_foods', {
  title: 'Get USDA Foods (Batch)',
  description:
    'Fetch nutrient profiles for several foods at once. More efficient than calling usda_get_food N times when you already have multiple FDC IDs. Accepts up to 500 IDs: repeats are dropped, the first 20 distinct IDs are fetched, and the rest are returned in deferredIds for a follow-up call. IDs FDC does not return before the call\'s deadline (slow Foundation records, most often) or keeps failing on also come back in deferredIds, ahead of those, named in a notice. Values are per 100 of each food\'s basisUnit, with no portion scaling: per 100 g (basisUnit "g"), except Branded foods FDC reports per 100 ml (basisUnit "ml") or per 100 of a label unit that fixes neither (basisUnit absent, basis unverified). Use the nutrients[] filter to limit response size — strongly recommended for batch calls; requested IDs a food does not report are listed in its missingNutrients. Set provenance=true to add to each nutrient how FDC obtained its value (derivation code, description, and source), its sample count (dataPoints), and the sample min, max, and median, each only where FDC sends it. For side-by-side comparison with a formatted table, use usda_compare_foods instead. Failed IDs (not found or no data) are reported in the failed[] array rather than aborting the entire batch.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    fdcIds: fdcIdList(BATCH_SIZE).describe(
      'FDC IDs to fetch — 2 to 500 entries (a server configured with strict limits rejects more than 20). Repeats are dropped; the first 20 distinct IDs are fetched and the rest are returned in deferredIds. Use usda_search_foods to discover IDs.',
    ),
    nutrients: z
      .array(z.number().int().min(1))
      .optional()
      .describe(
        'Filter to specific nutrient IDs (e.g. [1003, 1004, 1005, 1008]). Strongly recommended — full profiles can be large. Use usda_list_nutrients to look up IDs. Requested IDs a food does not report are listed in its missingNutrients.',
      ),
    provenance: z
      .boolean()
      .default(false)
      .describe(
        'Add to each nutrient what FDC records about its value: derivation (code, description, source), dataPoints (sample count), and min, max, median (sample spread, per 100 of basisUnit like amount). Each is present only where FDC sends it: Survey (FNDDS) foods send none, Branded foods only a derivation. Off by default; it makes the response two to three times as large.',
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
                    ...NUTRIENT_PROVENANCE_OUTPUT.shape,
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
        "Distinct requested IDs this call did not fetch, in request order: any FDC did not return before the call's deadline or kept failing on, then those past the first 20, which were never requested from FDC. foods and failed cover neither. Pass them to usda_get_foods again, or a single one to usda_get_food, with the same nutrients and provenance. Absent when every distinct ID was fetched.",
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Deferral notice when deferredIds is present: how many of the distinct IDs past the first 20 were not fetched, which fetched IDs FDC did not return before the deadline or kept failing on, and the call that fetches them.',
      ),
  },

  errors: [
    {
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: "FDC did not answer within the call's 45-second budget, across every attempt.",
      recovery:
        'Retry the call once. FDC builds some records slowly (Foundation foods most often); if it fails again, request fewer foods per call or fetch them one at a time with usda_get_food.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const distinct = [...new Set(input.fdcIds)];
    const fetchIds = distinct.slice(0, BATCH_SIZE);
    const pastBatch = distinct.slice(BATCH_SIZE);
    ctx.log.info('Fetching batch foods', { count: fetchIds.length });

    const {
      foods,
      failed,
      deferredIds: unanswered,
    } = await getFdcService().getFoodsBatch(
      fetchIds,
      input.nutrients?.length ? input.nutrients : undefined,
      ctx,
      { provenance: input.provenance },
    );

    ctx.log.info('Batch complete', { succeeded: foods.length, failed: failed.length });

    if (pastBatch.length > 0) {
      deferrals.add(1);
      ctx.log.notice('Deferred FDC IDs past the batch size', {
        requested: input.fdcIds.length,
        distinct: distinct.length,
        fetched: fetchIds.length,
        deferred: pastBatch.length,
      });
    }
    const deferredIds = [...unanswered, ...pastBatch];
    if (deferredIds.length > 0) {
      ctx.enrich.notice(deferralNotice(distinct.length, fetchIds.length, unanswered, deferredIds));
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
          ...(n.derivation && { derivation: n.derivation }),
          ...(n.dataPoints !== undefined && { dataPoints: n.dataPoints }),
          ...(n.min !== undefined && { min: n.min }),
          ...(n.max !== undefined && { max: n.max }),
          ...(n.median !== undefined && { median: n.median }),
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
      lines.push(
        `**FDC ID:** ${food.fdcId} | **Type:** ${escapeMarkdownInline(food.dataType)}${labelUnit}`,
      );
      const basis = escapeMarkdownInline(basisLabel(food.basisUnit, food.servingSizeUnit));
      if (food.nutrients.length > 0) {
        lines.push(`**Nutrients (${basis}):**`);
        for (const n of food.nutrients) {
          lines.push(
            `- ${escapeMarkdownInline(n.name)} (ID: ${n.id}${n.number ? `, SR#: ${escapeMarkdownInline(n.number)}` : ''}): ${n.amount} ${escapeMarkdownInline(n.unit)}${provenanceText(n)}`,
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
