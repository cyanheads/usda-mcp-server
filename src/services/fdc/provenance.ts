/**
 * @fileoverview FDC's per-nutrient provenance: how a value was derived, how
 * many samples stand behind it, and their spread. Read from a detail or batch
 * nutrient row, described for the usda_get_food and usda_get_foods output
 * schemas, and rendered for their `content[]`.
 * @module services/fdc/provenance
 */

import { z } from '@cyanheads/mcp-ts-core';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import type { NutrientProvenance, RawFoodNutrient } from './types.js';

/** `value` trimmed, or undefined when FDC sent none or only whitespace. */
function sentText(value: string | null | undefined): string | undefined {
  return value?.trim() || undefined;
}

/**
 * The provenance FDC sends on one detail or batch nutrient row. A key is
 * present only when FDC sends a value for it: a missing, `null`, or blank one
 * stays absent, and a value FDC does send, `dataPoints: 0` and a spread of
 * zeros included, is kept as sent. A derivation needs both its code and its
 * description; its source is optional. Nothing is inferred: a row with a
 * sample count and no derivation, as SR Legacy sends for measured values, gets
 * no derivation.
 */
export function nutrientProvenance(raw: RawFoodNutrient): NutrientProvenance {
  const derivation = raw.foodNutrientDerivation;
  const code = sentText(derivation?.code);
  const description = sentText(derivation?.description);
  const source = sentText(derivation?.foodNutrientSource?.description);
  return {
    ...(code && description && { derivation: { code, description, ...(source && { source }) } }),
    ...(raw.dataPoints != null && { dataPoints: raw.dataPoints }),
    ...(raw.min != null && { min: raw.min }),
    ...(raw.max != null && { max: raw.max }),
    ...(raw.median != null && { median: raw.median }),
  };
}

/** The nutrient fields `provenance: true` adds to usda_get_food and usda_get_foods output. */
export const NUTRIENT_PROVENANCE_OUTPUT = z.object({
  derivation: z
    .object({
      code: z.string().describe('FDC derivation code (e.g. "A", "NC", "Z", "LCCS").'),
      description: z
        .string()
        .describe(
          'What the code means, as FDC words it (e.g. "Analytical", "Calculated", "Summed").',
        ),
      source: z
        .string()
        .optional()
        .describe(
          'Source category FDC files the derivation under (e.g. "Analytical or derived from analytical", "Calculated or imputed", "Assumed zero"). Absent when FDC sends none.',
        ),
    })
    .optional()
    .describe(
      'How FDC obtained the value; with provenance=true only. Foundation and Branded send one on every value, SR Legacy on some (a measured SR Legacy value can carry only dataPoints), Survey (FNDDS) on none. Absent when FDC sends none, never inferred. Code "Z" is an assumed zero, not a measurement.',
    ),
  dataPoints: z
    .number()
    .optional()
    .describe(
      'Number of samples behind the value, as FDC sends it; with provenance=true only. SR Legacy sends it on every value (0 for calculated and assumed values), Foundation on analytical values; Branded and Survey (FNDDS) send none. A count, never scaled.',
    ),
  min: z
    .number()
    .optional()
    .describe(
      'Lowest sample value, in the same unit and basis as amount and scaled with it; with provenance=true only. Foundation sends it on most values, SR Legacy on some; Branded and Survey (FNDDS) send none.',
    ),
  max: z
    .number()
    .optional()
    .describe(
      'Highest sample value, in the same unit and basis as amount and scaled with it; with provenance=true only. Foundation sends it on most values, SR Legacy on some; Branded and Survey (FNDDS) send none.',
    ),
  median: z
    .number()
    .optional()
    .describe(
      'Median sample value, in the same unit and basis as amount and scaled with it; with provenance=true only. Foundation sends it on most values; SR Legacy, Branded, and Survey (FNDDS) send none.',
    ),
});

/**
 * A nutrient's provenance as a `content[]` suffix, ` — {code}: {description};
 * source: {source}; n={dataPoints}; range {min}–{max}; median {median}`, each
 * part omitted when its field is absent, and `''` when every one is. FDC's
 * text is escaped; numbers render as structuredContent carries them. FDC sends
 * `min` and `max` together; one that arrives alone renders as `min {min}` or
 * `max {max}`, never with an invented other bound.
 */
export function provenanceText(n: z.infer<typeof NUTRIENT_PROVENANCE_OUTPUT>): string {
  const { derivation, dataPoints, min, max, median } = n;
  const parts = [
    derivation &&
      `${escapeMarkdownInline(derivation.code)}: ${escapeMarkdownInline(derivation.description)}`,
    derivation?.source && `source: ${escapeMarkdownInline(derivation.source)}`,
    dataPoints !== undefined && `n=${dataPoints}`,
    min !== undefined && max !== undefined && `range ${min}–${max}`,
    min !== undefined && max === undefined && `min ${min}`,
    max !== undefined && min === undefined && `max ${max}`,
    median !== undefined && `median ${median}`,
  ].filter(Boolean);
  return parts.length > 0 ? ` — ${parts.join('; ')}` : '';
}
