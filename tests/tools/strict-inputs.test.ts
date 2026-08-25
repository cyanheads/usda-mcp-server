/**
 * @fileoverview Pins the strict root-level input contract every tool inherits
 * from `tool()`: an unrecognized argument key is rejected by name rather than
 * silently stripped, and the advertised `inputSchema` says so with
 * `additionalProperties: false` under JSON Schema 2020-12.
 *
 * A stripped key turns a caller's typo into a wrong answer they cannot detect —
 * the value disappears before the handler runs and the call fails downstream
 * pointing at the wrong problem. None of these tools proxies arbitrary upstream
 * parameters, so none opts back out with `.passthrough()` / `.catchall()`.
 * @module tests/tools/strict-inputs
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { usdaCompareFoods } from '@/mcp-server/tools/definitions/usda-compare-foods.tool.js';
import { usdaGetFood } from '@/mcp-server/tools/definitions/usda-get-food.tool.js';
import { usdaGetFoods } from '@/mcp-server/tools/definitions/usda-get-foods.tool.js';
import { usdaListNutrients } from '@/mcp-server/tools/definitions/usda-list-nutrients.tool.js';
import { usdaSearchFoods } from '@/mcp-server/tools/definitions/usda-search-foods.tool.js';

/** Every tool by name, with a minimal valid argument object for it. */
const TOOLS = [
  [usdaListNutrients.name, usdaListNutrients.input, {}],
  [usdaSearchFoods.name, usdaSearchFoods.input, { query: 'kale' }],
  [usdaGetFood.name, usdaGetFood.input, { fdcId: 168421 }],
  [usdaGetFoods.name, usdaGetFoods.input, { fdcIds: [168421, 168462] }],
  [usdaCompareFoods.name, usdaCompareFoods.input, { fdcIds: [168421, 168462] }],
] as const satisfies ReadonlyArray<readonly [string, z.ZodType, Record<string, unknown>]>;

describe('strict tool inputs', () => {
  it.each(TOOLS)('%s accepts its minimal valid arguments', (_name, input, valid) => {
    expect(input.safeParse(valid).success).toBe(true);
  });

  it.each(TOOLS)(
    '%s rejects an unrecognized key by name instead of stripping it',
    (_name, input, valid) => {
      const result = input.safeParse({ ...valid, notADeclaredKey: 'x' });

      expect(result.success).toBe(false);
      const issue = result.error?.issues[0];
      expect(issue?.code).toBe('unrecognized_keys');
      expect(issue?.message).toContain('notADeclaredKey');
    },
  );

  it.each(TOOLS)(
    '%s advertises additionalProperties: false under JSON Schema 2020-12',
    (_name, input) => {
      const schema = z.toJSONSchema(input) as Record<string, unknown>;

      expect(schema.additionalProperties).toBe(false);
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    },
  );

  it('rejects a near-miss of a real key rather than answering the unfiltered query', () => {
    // `querry` would have been dropped under the old strip semantics, leaving
    // the handler to fail on a missing required `query` instead.
    const result = usdaSearchFoods.input.safeParse({ query: 'kale', querry: 'kale' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('querry');
  });

  it('rejects a nutrient filter misspelled as the singular form', () => {
    const result = usdaGetFood.input.safeParse({ fdcId: 168421, nutrient: [1003] });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('nutrient');
  });
});
