/**
 * @fileoverview Tests for usda_list_nutrients tool.
 * @module tests/tools/usda-list-nutrients.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { usdaListNutrients } from '@/mcp-server/tools/definitions/usda-list-nutrients.tool.js';
import { NUTRIENT_REFERENCE } from '@/services/fdc/nutrient-reference.js';
import { allText, firstText } from '../helpers.js';

const { format } = usdaListNutrients;
if (!format) throw new Error('usda_list_nutrients must declare format()');

/** Every category the input enum accepts — each must resolve to rows. */
const CATEGORIES = [
  'macronutrients',
  'vitamins',
  'minerals',
  'lipids',
  'amino_acids',
  'other',
] as const;

// No service dependency — reads from static NUTRIENT_REFERENCE

describe('usdaListNutrients', () => {
  it('returns all nutrients when no category is specified', async () => {
    const ctx = createMockContext();
    const input = usdaListNutrients.input.parse({});
    const result = await usdaListNutrients.handler(input, ctx);

    expect(result.nutrients.length).toBeGreaterThan(0);
    for (const n of result.nutrients) {
      expect(n).toHaveProperty('id');
      expect(n).toHaveProperty('name');
      expect(n).toHaveProperty('number');
      expect(n).toHaveProperty('unit');
      expect(n).toHaveProperty('category');
    }
  });

  it('filters to macronutrients only', async () => {
    const ctx = createMockContext();
    const input = usdaListNutrients.input.parse({ category: 'macronutrients' });
    const result = await usdaListNutrients.handler(input, ctx);

    expect(result.nutrients.length).toBeGreaterThan(0);
    for (const n of result.nutrients) {
      expect(n.category).toBe('macronutrients');
    }
  });

  it('filters to vitamins only', async () => {
    const ctx = createMockContext();
    const input = usdaListNutrients.input.parse({ category: 'vitamins' });
    const result = await usdaListNutrients.handler(input, ctx);

    expect(result.nutrients.length).toBeGreaterThan(0);
    for (const n of result.nutrients) {
      expect(n.category).toBe('vitamins');
    }
  });

  it('filters to minerals only', async () => {
    const ctx = createMockContext();
    const input = usdaListNutrients.input.parse({ category: 'minerals' });
    const result = await usdaListNutrients.handler(input, ctx);

    expect(result.nutrients.length).toBeGreaterThan(0);
    for (const n of result.nutrients) {
      expect(n.category).toBe('minerals');
    }
  });

  it('has no duplicate nutrient IDs', async () => {
    const ctx = createMockContext();
    const input = usdaListNutrients.input.parse({});
    const result = await usdaListNutrients.handler(input, ctx);

    const ids = result.nutrients.map((n) => n.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('has no duplicate (name, unit) pair — FDC reuses a name only across units', async () => {
    const ctx = createMockContext();
    const input = usdaListNutrients.input.parse({});
    const result = await usdaListNutrients.handler(input, ctx);

    const byPair = new Map<string, number[]>();
    const byName = new Map<string, number[]>();
    for (const n of result.nutrients) {
      const pair = `${n.name} (${n.unit})`;
      byPair.set(pair, [...(byPair.get(pair) ?? []), n.id]);
      byName.set(n.name, [...(byName.get(n.name) ?? []), n.id]);
    }
    expect([...byPair].filter(([, ids]) => ids.length > 1)).toEqual([]);
    expect([...byName].filter(([, ids]) => ids.length > 1)).toEqual([
      ['Energy', [1008, 1062]],
      ['Vitamin E', [1158, 2068]],
    ]);
  });

  it('has no duplicate SR reference number, and an empty one only where FDC assigns none', async () => {
    const ctx = createMockContext();
    const input = usdaListNutrients.input.parse({});
    const result = await usdaListNutrients.handler(input, ctx);

    const byNumber = new Map<string, string[]>();
    for (const n of result.nutrients.filter((row) => row.number !== '')) {
      byNumber.set(n.number, [...(byNumber.get(n.number) ?? []), `${n.id} ${n.name}`]);
    }
    const collisions = [...byNumber].filter(([, rows]) => rows.length > 1);
    expect(collisions).toEqual([]);
    expect(
      result.nutrients
        .filter((n) => n.number === '')
        .map((n) => n.id)
        .sort((a, b) => a - b),
    ).toEqual([2052, 2053, 2057, 2058, 2059, 2060, 2061, 2062, 2063]);
  });

  it('uses correct ID for Calcium (1087) not Galactose', async () => {
    const ctx = createMockContext();
    const input = usdaListNutrients.input.parse({});
    const result = await usdaListNutrients.handler(input, ctx);

    const calcium = result.nutrients.find((n) => n.id === 1087);
    expect(calcium?.name).toBe('Calcium, Ca');

    const galactose = result.nutrients.find((n) => n.name === 'Galactose');
    expect(galactose?.id).toBe(1075);
  });

  it('includes well-known nutrient IDs for common categories', async () => {
    const ctx = createMockContext();
    const allInput = usdaListNutrients.input.parse({});
    const result = await usdaListNutrients.handler(allInput, ctx);

    const ids = result.nutrients.map((n) => n.id);
    // Core nutrients expected to be present
    expect(ids).toContain(1008); // Energy
    expect(ids).toContain(1003); // Protein
    expect(ids).toContain(1004); // Total fat
    expect(ids).toContain(1005); // Carbohydrate
  });

  it('carries the FDC ids for Lactose, Maltose, and Lutein + zeaxanthin', async () => {
    const ctx = createMockContext();
    const input = usdaListNutrients.input.parse({});
    const result = await usdaListNutrients.handler(input, ctx);
    const byName = new Map(result.nutrients.map((n) => [n.name, n]));

    expect(byName.get('Lactose')).toMatchObject({ id: 1013, number: '213', unit: 'G' });
    expect(byName.get('Maltose')).toMatchObject({ id: 1014, number: '214', unit: 'G' });
    expect(byName.get('Lutein + zeaxanthin')).toMatchObject({
      id: 1123,
      number: '338',
      unit: 'UG',
    });
  });

  it('renders the restored rows in the text content block', async () => {
    const ctx = createMockContext();
    const input = usdaListNutrients.input.parse({});
    const result = await usdaListNutrients.handler(input, ctx);
    const text = firstText(format(result));

    expect(text).toContain('**Lactose** (ID: 1013)');
    expect(text).toContain('**Maltose** (ID: 1014)');
    expect(text).toContain('**Lutein + zeaxanthin** (ID: 1123)');
  });

  it('rejects an unknown category', () => {
    expect(() => usdaListNutrients.input.parse({ category: 'phytonutrients' })).toThrow();
  });

  it('scopes each category to its own rows and covers the whole table', async () => {
    const ctx = createMockContext();
    const all = await usdaListNutrients.handler(usdaListNutrients.input.parse({}), ctx);

    let scopedTotal = 0;
    for (const category of CATEGORIES) {
      const scoped = await usdaListNutrients.handler(
        usdaListNutrients.input.parse({ category }),
        ctx,
      );
      // A category that went empty is a table defect, not a valid filter result.
      expect(scoped.nutrients.length).toBeGreaterThan(0);
      expect(scoped.nutrients.filter((n) => n.category !== category)).toEqual([]);
      scopedTotal += scoped.nutrients.length;
    }
    expect(scopedTotal).toBe(all.nutrients.length);
  });

  it('formats a zero-row result without inventing rows', () => {
    const text = firstText(format({ nutrients: [] }));

    expect(text).toContain('0 nutrients');
    expect(text).not.toContain('(ID:');
  });

  it('formats output with count and nutrient rows including IDs', () => {
    const output = {
      nutrients: [
        { id: 1003, name: 'Protein', number: '203', unit: 'G', category: 'macronutrients' },
        { id: 1162, name: 'Vitamin C', number: '401', unit: 'MG', category: 'vitamins' },
      ],
    };
    const text = firstText(format(output));
    expect(text).toContain('2 nutrients');
    // IDs and names must appear so the LLM can map names → IDs
    expect(text).toContain('1003');
    expect(text).toContain('Protein');
    expect(text).toContain('1162');
    expect(text).toContain('Vitamin C');
    expect(text).toContain('203'); // SR number
  });

  it('heads a one-row result in the singular', () => {
    const text = firstText(
      format({
        nutrients: [
          { id: 1062, name: 'Energy', number: '268', unit: 'kJ', category: 'macronutrients' },
        ],
      }),
    );

    expect(text.split('\n')[0]).toBe('**1 nutrient**');
  });

  it('leaves out the SR number FDC does not assign, and renders names as text', () => {
    const text = firstText(
      format({
        nutrients: [
          { id: 2057, name: 'Ergothioneine', number: '', unit: 'MG', category: 'other' },
          { id: 90_001, name: 'A*b* [c]', number: '1', unit: 'G', category: 'other' },
        ],
      }),
    );

    expect(text).toContain('**Ergothioneine** (ID: 2057) | Unit: MG | Category: other');
    expect(text).toContain('**A\\*b\\* \\[c\\]** (ID: 90001) | Unit: G | SR#: 1 | Category: other');
  });
});

/** One call through the tool's contract boundary: both surfaces, enrichment included. */
async function callTool(args: Record<string, unknown>) {
  const result = await runToolContract(usdaListNutrients, args);
  expect(result.isError).toBeFalsy();
  return {
    structured: result.structuredContent as {
      effectiveQuery?: string;
      notice?: string;
      nutrients: Array<{ category: string; id: number; name: string }>;
    },
    text: allText(result.content),
  };
}

/** Sorted IDs of a result's rows. */
const idsOf = (rows: ReadonlyArray<{ id: number }>) => rows.map((n) => n.id).sort((a, b) => a - b);

describe('usdaListNutrients query', () => {
  it('lists the whole table when called with no filter', async () => {
    const { structured } = await callTool({});

    expect(structured).toEqual({ nutrients: NUTRIENT_REFERENCE });
  });

  it.each(['lutein', 'LUTEIN', '  Lutein '])(
    'matches %j against names, case-insensitively',
    async (query) => {
      const { structured } = await callTool({ query });

      expect(idsOf(structured.nutrients)).toEqual([1121, 1123, 1161]);
    },
  );

  it.each(['1062', '268', ' 268 '])('matches %j as a whole FDC ID or SR number', async (query) => {
    const { structured } = await callTool({ query });

    expect(idsOf(structured.nutrients)).toEqual([1062]);
  });

  it('matches digits within an ID or number only by name', async () => {
    const { structured } = await callTool({ query: '20' });

    // 2000 (Total Sugars) and 2047 hold "20" in their IDs but not in their names.
    expect(structured.nutrients.length).toBeGreaterThan(0);
    expect(structured.nutrients.filter((n) => !n.name.includes('20'))).toEqual([]);
  });

  it('combines query with category', async () => {
    const all = await callTool({ query: 'acid' });
    const scoped = await callTool({ query: 'acid', category: 'amino_acids' });
    const vitamins = await callTool({ query: 'lutein', category: 'vitamins' });

    expect(new Set(all.structured.nutrients.map((n) => n.category)).size).toBeGreaterThan(1);
    expect(scoped.structured.nutrients.length).toBeGreaterThan(0);
    expect(scoped.structured.nutrients).toEqual(
      all.structured.nutrients.filter((n) => n.category === 'amino_acids'),
    );
    expect(idsOf(vitamins.structured.nutrients)).toEqual([1121, 1123, 1161]);
  });

  it('answers a query no row in the category matches with a notice on both surfaces', async () => {
    const { structured, text } = await callTool({ query: 'fiber', category: 'lipids' });

    expect(structured).toEqual({
      nutrients: [],
      effectiveQuery: 'fiber',
      notice: `No nutrient in category lipids matches this query. Names follow FDC's spelling (e.g. "Vitamin B-12", "PUFA 22:6 n-3 (DHA)"): try a shorter term or drop category, or omit both to list all ${NUTRIENT_REFERENCE.length} nutrients.`,
    });
    expect(text).toContain('**0 nutrients**');
    expect(text).toContain('Query: `fiber`');
    expect(text).toContain(`> ${structured.notice}`);
  });

  it('echoes the trimmed query when "  xyzzy " matches nothing', async () => {
    const { structured, text } = await callTool({ query: '  xyzzy ' });

    expect(structured.nutrients).toEqual([]);
    expect(structured.effectiveQuery).toBe('xyzzy');
    expect(text).toContain('Query: `xyzzy`');
  });

  it('names no category in the notice when none was given', async () => {
    const { structured } = await callTool({ query: 'no such nutrient' });

    expect(structured.nutrients).toEqual([]);
    expect(structured.notice).toBe(
      `No nutrient matches this query. Names follow FDC's spelling (e.g. "Vitamin B-12", "PUFA 22:6 n-3 (DHA)"): try a shorter term, or omit query to list all ${NUTRIENT_REFERENCE.length} nutrients.`,
    );
  });

  it.each(['', '   ', '\t\n '])('treats the blank query %j as no query', async (query) => {
    const blank = await callTool({ query });
    const none = await callTool({});

    expect(blank).toEqual(none);
  });

  it('carries the query raw in structuredContent and inert in content[]', async () => {
    const query = '**bold** _em_ [link](https://x.test) <b>x</b> # h';
    const { structured, text } = await callTool({ query });

    expect(structured.effectiveQuery).toBe(query);
    expect(structured.notice).not.toContain('bold');
    expect(text).toContain(`Query: \`${query}\``);
    expect(text).not.toContain('\\*');
  });

  it('sizes the code literal past backticks and line breaks in the query', async () => {
    const backtick = await callTool({ query: 'a`b' });
    const multiline = await callTool({ query: 'x\ny' });

    expect(backtick.structured.effectiveQuery).toBe('a`b');
    expect(backtick.text).toContain('Query: ``a`b``');
    expect(multiline.structured.effectiveQuery).toBe('x\ny');
    expect(multiline.text).toContain('Query: \n```\nx\ny\n```\n');
  });
});

/**
 * `query` has no length cap, and a call whose query matches nothing echoes it
 * into content[] as a code literal, so the whole call must stay linear in its
 * length. Each shape doubles from 10k characters against a 5k baseline, every
 * size must fit a CPU budget and grow under 256× the baseline — a quadratic
 * pass shows 4096× across 64× — before the next size runs. The digit run
 * carries the full 64× span; shapes that reach the framework's regex scans stop
 * at 80k, below the size where Bun's regex engine changes mode. Each
 * measurement times a batch of calls and keeps the least of three batches, and
 * the baseline is re-timed beside every size so a move between a performance
 * and an efficiency core cannot fail linear work.
 */
describe('usdaListNutrients query timing', () => {
  const BASE = 5_000;
  const FULL_SPAN = [10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  const REGEX_SPAN = [10_000, 20_000, 40_000, 80_000];
  /** Linear work at any size — about 1 µs a character plus the call's fixed cost. */
  const budgetUs = (size: number) => 20_000 + size;

  /** Builds a string of about `size` characters by repeating `unit`. */
  const repeat = (unit: string, size: number, tail = '') =>
    unit.repeat(Math.ceil(size / unit.length)) + tail;

  const SHAPES: ReadonlyArray<readonly [string, (size: number) => string, readonly number[]]> = [
    ['a long digit run', (size) => repeat('7', size), FULL_SPAN],
    ['a repeated name prefix', (size) => repeat('Vitamin ', size), FULL_SPAN],
    ['one long line ending in a break', (size) => `${repeat('§1 x', size)}\ny`, REGEX_SPAN],
    ['breaks throughout', (size) => repeat('  \r\n', size), REGEX_SPAN],
    ['breaks throughout between text', (size) => `x${repeat('  \r\n', size)}y`, REGEX_SPAN],
    ['one backtick run', (size) => repeat('`', size), REGEX_SPAN],
    ['alternating backticks', (size) => repeat('`a', size), REGEX_SPAN],
  ];

  /** Keeps every result observable, so no call can be optimized away. */
  let sink = 0;

  /** Least thread CPU time per call, in µs, over three batches of about 80k characters each. */
  async function perCallMicros(query: string): Promise<number> {
    const calls = Math.max(1, Math.round(80_000 / query.length));
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const start = process.threadCpuUsage();
      for (let call = 0; call < calls; call++) {
        sink += (await runToolContract(usdaListNutrients, { query })).content.length;
      }
      const used = process.threadCpuUsage(start);
      best = Math.min(best, (used.user + used.system) / calls);
    }
    return best;
  }

  it.each(SHAPES)(
    'stays linear on %s',
    async (_shape, build, sizes) => {
      const base = build(BASE);
      await perCallMicros(base); // warm the JIT before measuring
      for (const size of sizes) {
        const input = build(size);
        let least = Number.POSITIVE_INFINITY;
        let growth = Number.POSITIVE_INFINITY;
        for (let pair = 0; pair < 2; pair++) {
          const baseline = Math.max(await perCallMicros(base), 0.01);
          const elapsed = await perCallMicros(input);
          least = Math.min(least, elapsed);
          growth = Math.min(growth, elapsed / baseline);
        }
        expect(least, `${size} chars`).toBeLessThan(budgetUs(size));
        expect(growth, `${size} chars against ${BASE}`).toBeLessThan(256);
      }
      expect(sink).toBeGreaterThan(0);
    },
    0,
  );
});
