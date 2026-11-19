/**
 * @fileoverview The `fdcIds` input shared by usda_get_foods and usda_compare_foods: 2 to 500 FDC IDs, with a per-tool cap that only strict limits enforce.
 * @module mcp-server/tools/fdc-id-list
 */

import { z } from '@cyanheads/mcp-ts-core';
import { getLimitsConfig } from '@/config/server-config.js';

/** The most `fdcIds` entries a call accepts; distinct IDs past a tool's own cap are deferred. */
const MAX_ENTRIES = 500;

/**
 * 2 to {@link MAX_ENTRIES} FDC IDs. USDA_CLAMP_LIMITS=false keeps the tool's
 * `strictMax` bound, raising the same issue a `.max(strictMax)` would without
 * changing the advertised schema. Config is read at validation, never at import.
 */
export function fdcIdList(strictMax: number) {
  return z
    .array(z.number().int().min(1))
    .min(2)
    .max(MAX_ENTRIES, {
      /**
       * Under strict limits the bound a caller must meet is `strictMax`, so a
       * call past 500 names it too; undefined keeps Zod's default.
       */
      error: () =>
        getLimitsConfig().clampLimits
          ? undefined
          : `Too big: expected array to have <=${strictMax} items`,
    })
    .superRefine((fdcIds, refinement) => {
      if (fdcIds.length > strictMax && !getLimitsConfig().clampLimits) {
        refinement.addIssue({
          code: 'too_big',
          maximum: strictMax,
          origin: 'array',
          inclusive: true,
          input: fdcIds,
        });
      }
    });
}
