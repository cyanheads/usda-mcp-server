/**
 * @fileoverview Writes `src/services/fdc/nutrient-reference.ts`, the static nutrient table, from
 * FDC's nutrient dictionary and the list of nutrient IDs FDC foods report.
 * @module scripts/generate-nutrient-reference
 *
 * Run `bun run scripts/generate-nutrient-reference.ts` after changing either
 * input or this script. The written module is checked in, and a test fails
 * while it differs from a fresh generation.
 *
 * Inputs, in `scripts/data/`:
 *
 * - `nutrient.csv` — FDC's nutrient dictionary, byte for byte as a bulk CSV
 *   download from https://fdc.nal.usda.gov/download-datasets ships it. Its
 *   `id`, `name`, `nutrient_nbr`, and `unit_name` become each row's `id`,
 *   `name`, `number`, and `unit` verbatim; its `rank` (FDC's display order)
 *   sets `category` and the row order.
 * - `reported-nutrient-ids.json` — the IDs at least one food reports with an
 *   amount, with the count of foods reporting each per data type, and each
 *   source's release and date. It was counted from:
 *   - Foundation: the JSON download, since that release's CSV download
 *     carries no `food.csv` or `food_nutrient.csv`;
 *   - SR Legacy: `food_nutrient.csv`;
 *   - Survey (FNDDS): `food_nutrient.csv`, whose `nutrient_id` column holds SR
 *     numbers (`nutrient_nbr`), not IDs, mapped to IDs through `nutrient.csv`;
 *   - Branded: pages of `/v1/foods/search` results, no Branded bulk file, so
 *     its set is a lower bound.
 *   A row without an amount is not counted: FDC ships amount-less placeholder
 *   rows, some for IDs the dictionary lacks (2066 "Vitamin A"), and the server
 *   drops amount-less rows from every food it returns. Entries marked
 *   `retained` are rows an earlier table held that no sampled food reports; a
 *   sample cannot show that no food does.
 *
 * Generation fails on a listed ID with no dictionary row or no category.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { NutrientCategory, NutrientReference } from '../src/services/fdc/types.js';

/** The generated module. */
export const MODULE_PATH = fileURLToPath(
  new URL('../src/services/fdc/nutrient-reference.ts', import.meta.url),
);

const DATA_DIR = new URL('./data/', import.meta.url);

/** Provenance of one input: its release or sample date, and the file or request it came from. */
const ProvenanceSchema = z.strictObject({ date: z.string(), from: z.string() });

/** A food source, with the number of foods read from it. */
const SourceSchema = ProvenanceSchema.extend({ foods: z.int().positive() });

const DATA_TYPES = ['Foundation', 'SR Legacy', 'Survey (FNDDS)', 'Branded'] as const;

const ReportedNutrientIdsSchema = z.strictObject({
  dictionary: ProvenanceSchema,
  sources: z.strictObject({
    Foundation: SourceSchema,
    'SR Legacy': SourceSchema,
    'Survey (FNDDS)': SourceSchema,
    Branded: SourceSchema,
  }),
  nutrients: z.array(
    z.union([
      z.strictObject({
        id: z.int().positive(),
        foods: z
          .partialRecord(z.enum(DATA_TYPES), z.int().positive())
          .refine((foods) => Object.keys(foods).length > 0, 'names no source reporting it'),
      }),
      z.strictObject({ id: z.int().positive(), retained: z.literal(true) }),
    ]),
  ),
});

/** `scripts/data/reported-nutrient-ids.json`, parsed. */
export type ReportedNutrientIds = z.infer<typeof ReportedNutrientIdsSchema>;

const CSV_HEADER = '"id","name","unit_name","nutrient_nbr","rank"';

/** Every field quoted and none holding a quote — the only form `nutrient.csv` uses. */
const CSV_ROW = /^"[^"]*"(?:,"[^"]*")*$/;

const CsvFieldsSchema = z.tuple([
  z.string().regex(/^[1-9]\d*$/),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
]);

/** FDC's rank for a nutrient it does not place in its display order. */
const UNRANKED = 999_999;

interface DictionaryRow {
  id: number;
  name: string;
  number: string;
  /** FDC display order; undefined when FDC leaves the nutrient unranked. */
  rank: number | undefined;
  unit: string;
}

/**
 * `category` by FDC `rank`, each band running from its floor to the next. The
 * floors of minerals, vitamins, lipids, and amino acids are the ranks of FDC's
 * own group-header rows (2043 Minerals 5200, 2046 Vitamins and Other
 * Components 6250, 2044 Lipids 9600, 2042 Amino acids 16250). Organic acids
 * start at 2850, and the components after the last amino acid at 18200
 * (alcohol, caffeine, theobromine, ergothioneine, isoflavones).
 */
const RANK_BANDS: ReadonlyArray<readonly [floor: number, category: NutrientCategory]> = [
  [0, 'macronutrients'],
  [2850, 'other'],
  [5200, 'minerals'],
  [6250, 'vitamins'],
  [9600, 'lipids'],
  [16250, 'amino_acids'],
  [18200, 'other'],
];

/** Rows whose `category` is not their rank band's. */
const CATEGORY_OVERRIDES: ReadonlyMap<number, NutrientCategory> = new Map([
  // Categories earlier tables gave these rows, which their rank bands would change.
  [1002, 'other'],
  [1024, 'other'],
  [1053, 'other'],
  [1198, 'other'],
  [1181, 'vitamins'],
  [1057, 'macronutrients'],
  [1058, 'macronutrients'],
  // Glutathione ranks among the vitamins but is not one.
  [2069, 'other'],
  // Unranked (rank 999999 or blank), so no band applies.
  [1072, 'macronutrients'],
  [1080, 'macronutrients'],
  [1086, 'macronutrients'],
  [1088, 'minerals'],
  [1096, 'minerals'],
  [1124, 'vitamins'],
  [1191, 'vitamins'],
  [1192, 'vitamins'],
  [1234, 'other'],
]);

/** Category order of the table — the grouping the table has always had. */
const CATEGORY_ORDER = [
  'macronutrients',
  'lipids',
  'minerals',
  'vitamins',
  'amino_acids',
  'other',
] as const satisfies readonly NutrientCategory[];

/** Reads both checked-in inputs, parsing the ID list against its schema. */
export function readGeneratorInputs(): { dictionaryCsv: string; manifest: ReportedNutrientIds } {
  const manifestText = readFileSync(new URL('reported-nutrient-ids.json', DATA_DIR), 'utf8');
  return {
    dictionaryCsv: readFileSync(new URL('nutrient.csv', DATA_DIR), 'utf8'),
    manifest: ReportedNutrientIdsSchema.parse(JSON.parse(manifestText)),
  };
}

/** Parses `nutrient.csv`, keyed by ID. Throws on any line that is not a dictionary row. */
function parseDictionary(csv: string): Map<number, DictionaryRow> {
  const [header, ...lines] = csv.replace(/\n$/, '').split('\n');
  if (header !== CSV_HEADER) {
    throw new Error(`nutrient.csv must open with the header ${CSV_HEADER}, not ${header}`);
  }
  const rows = new Map<number, DictionaryRow>();
  for (const [index, line] of lines.entries()) {
    const fields = CsvFieldsSchema.safeParse(
      CSV_ROW.test(line) ? line.slice(1, -1).split('","') : [],
    );
    if (!fields.success) {
      throw new Error(`nutrient.csv line ${index + 2} is not an FDC dictionary row: ${line}`, {
        cause: fields.error,
      });
    }
    const [id, name, unit, number, rankText] = fields.data;
    const rank = rankText === '' ? UNRANKED : Number(rankText);
    if (Number.isNaN(rank)) {
      throw new Error(`nutrient.csv line ${index + 2} has a non-numeric rank: ${rankText}`);
    }
    rows.set(Number(id), {
      id: Number(id),
      name,
      number,
      unit,
      rank: rank >= UNRANKED ? undefined : rank,
    });
  }
  return rows;
}

/** A row's category: its override, else its rank band; undefined for an unranked row with no override. */
function categoryOf(row: DictionaryRow): NutrientCategory | undefined {
  const override = CATEGORY_OVERRIDES.get(row.id);
  if (override) return override;
  const { rank } = row;
  if (rank === undefined) return;
  return RANK_BANDS.findLast(([floor]) => rank >= floor)?.[1];
}

/**
 * The table rows for the listed IDs: each joined to its `nutrient.csv` row,
 * grouped by category, and ordered by FDC rank within each (unranked rows
 * last, by ID). Throws on a listed ID that is repeated, has no dictionary row,
 * or has no category.
 */
export function buildNutrientRows(
  dictionaryCsv: string,
  nutrients: ReportedNutrientIds['nutrients'],
): NutrientReference[] {
  const dictionary = parseDictionary(dictionaryCsv);
  const seen = new Set<number>();
  const ranked: { rank: number; row: NutrientReference }[] = [];
  for (const { id } of nutrients) {
    if (seen.has(id)) throw new Error(`Nutrient ${id} is listed twice`);
    seen.add(id);
    const entry = dictionary.get(id);
    if (!entry) throw new Error(`Nutrient ${id} is listed but has no nutrient.csv row`);
    const category = categoryOf(entry);
    if (!category) {
      throw new Error(
        `Nutrient ${id} (${entry.name}) has no category: it is unranked, so add it to CATEGORY_OVERRIDES`,
      );
    }
    const { name, number, unit } = entry;
    // Unranked rows sort after every ranked row of their category.
    ranked.push({
      rank: entry.rank ?? Number.POSITIVE_INFINITY,
      row: { id, name, number, unit, category },
    });
  }
  ranked.sort(
    (a, b) =>
      CATEGORY_ORDER.indexOf(a.row.category) - CATEGORY_ORDER.indexOf(b.row.category) ||
      a.rank - b.rank ||
      a.row.id - b.row.id,
  );
  return ranked.map(({ row }) => row);
}

/** A TypeScript string literal in the quotes Biome's formatter settles on. */
function tsString(value: string): string {
  if (value.includes("'") && !value.includes('"')) return JSON.stringify(value);
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

/** One array element, on one line when it fits Biome's 100-column width and one property per line otherwise. */
function renderRow({ id, name, number, unit, category }: NutrientReference): string {
  const props = [
    `id: ${id}`,
    `name: ${tsString(name)}`,
    `number: ${tsString(number)}`,
    `unit: ${tsString(unit)}`,
    `category: ${tsString(category)}`,
  ];
  const line = `  { ${props.join(', ')} },`;
  if (line.length <= 100) return line;
  return ['  {', ...props.map((prop) => `    ${prop},`), '  },'].join('\n');
}

/** The source of `src/services/fdc/nutrient-reference.ts` for `rows`, in the form Biome's formatter leaves unchanged. */
export function renderNutrientReferenceModule(
  rows: readonly NutrientReference[],
  manifest: ReportedNutrientIds,
): string {
  const { dictionary, sources } = manifest;
  const retained = manifest.nutrients.filter((n) => 'retained' in n).length;
  const body: string[] = [];
  for (const category of CATEGORY_ORDER) {
    const group = rows.filter((row) => row.category === category);
    if (group.length === 0) continue;
    if (body.length > 0) body.push('');
    body.push(`  // --- ${category} ---`, ...group.map(renderRow));
  }
  return `/**
 * @fileoverview Static FDC nutrient reference table — the nutrients FoodData Central foods report, with IDs, names, SR numbers, units, and categories.
 * @module services/fdc/nutrient-reference
 *
 * Generated by scripts/generate-nutrient-reference.ts; do not edit. Change the
 * generator or its inputs in scripts/data/, then run
 * \`bun run scripts/generate-nutrient-reference.ts\`.
 *
 * \`id\`, \`name\`, \`number\`, and \`unit\` are FDC's nutrient dictionary verbatim
 * (its \`id\`, \`name\`, \`nutrient_nbr\`, and \`unit_name\`), from
 * ${dictionary.from} (${dictionary.date}).
 * An empty \`number\` means FDC assigns that nutrient no SR number.
 *
 * The rows are every dictionary nutrient that some food reports with an
 * amount: Foundation ${sources.Foundation.date}, SR Legacy ${sources['SR Legacy'].date},
 * Survey (FNDDS) ${sources['Survey (FNDDS)'].date}, and a Branded search sample of
 * ${sources.Branded.date}; plus ${retained} rows earlier tables held that no sampled food reports.
 *
 * \`category\` is this server's grouping, by FDC \`rank\`. Rows run by category,
 * in FDC rank order within each.
 */

import type { NutrientReference } from './types.js';

/** Every tracked FDC nutrient, grouped by category. */
export const NUTRIENT_REFERENCE: NutrientReference[] = [
${body.join('\n')}
];

/** Lookup map from ID to nutrient reference for O(1) access. */
export const NUTRIENT_BY_ID: Map<number, NutrientReference> = new Map(
  NUTRIENT_REFERENCE.map((n) => [n.id, n]),
);
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { dictionaryCsv, manifest } = readGeneratorInputs();
  const rows = buildNutrientRows(dictionaryCsv, manifest.nutrients);
  writeFileSync(MODULE_PATH, renderNutrientReferenceModule(rows, manifest));
  const counts = CATEGORY_ORDER.map((c) => `${c} ${rows.filter((r) => r.category === c).length}`);
  console.log(`Wrote ${rows.length} rows to ${MODULE_PATH} (${counts.join(', ')})`);
}
