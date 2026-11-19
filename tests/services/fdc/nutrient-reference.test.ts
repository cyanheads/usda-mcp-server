/**
 * @fileoverview Tests for the static FDC nutrient reference table and the generator that writes it.
 * @module tests/services/fdc/nutrient-reference.test
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NUTRIENT_BY_ID, NUTRIENT_REFERENCE } from '@/services/fdc/nutrient-reference.js';
import type { NutrientCategory } from '@/services/fdc/types.js';
import {
  buildNutrientRows,
  MODULE_PATH,
  type ReportedNutrientIds,
  readGeneratorInputs,
  renderNutrientReferenceModule,
} from '../../../scripts/generate-nutrient-reference.js';

/** Every `NutrientCategory`, in the order the table groups them. */
const CATEGORIES: readonly NutrientCategory[] = [
  'macronutrients',
  'lipids',
  'minerals',
  'vitamins',
  'amino_acids',
  'other',
];

/**
 * `scripts/data/nutrient.csv` lines by ID, read without the generator. Every
 * field in the file is quoted and none holds a quote, so a line's ID ends at
 * its first `","` and its rank, the last field, starts after its last `,"`.
 */
const DICTIONARY_LINES = new Map(
  readFileSync(new URL('../../../scripts/data/nutrient.csv', import.meta.url), 'utf8')
    .trimEnd()
    .split('\n')
    .slice(1)
    .map((line) => [Number(line.slice(1, line.indexOf('","'))), line] as const),
);

/** FDC rank of a dictionary line, with FDC's 999999 and a blank rank both unranked. */
function rankOf(id: number): number {
  const line = DICTIONARY_LINES.get(id);
  if (line === undefined) throw new Error(`nutrient.csv has no line for ${id}`);
  const rank = line.slice(line.lastIndexOf(',"') + 2, -1);
  return rank === '' || Number(rank) >= 999_999 ? Number.POSITIVE_INFINITY : Number(rank);
}

/** A `nutrient.csv` text holding the given `[id, name, unit_name, nutrient_nbr, rank]` rows. */
function dictionaryCsv(rows: ReadonlyArray<readonly [number, string, string, string, string]>) {
  const lines = rows.map((fields) => fields.map((field) => `"${field}"`).join(','));
  return `"id","name","unit_name","nutrient_nbr","rank"\n${lines.join('\n')}\n`;
}

/** The reported-ID entries for `ids`, each reported by one Foundation food. */
function reported(...ids: number[]): ReportedNutrientIds['nutrients'] {
  return ids.map((id) => ({ id, foods: { Foundation: 1 } }));
}

/**
 * Every row the 0.2.2 table held, by its 0.2.2 category. Later tables add rows
 * but never drop or regroup one of these.
 */
const CATEGORY_0_2_2: Readonly<Record<NutrientCategory, readonly number[]>> = {
  macronutrients: [
    1003, 1004, 1005, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 1050, 1051, 1057, 1058, 1063,
    1075, 1079, 1082, 1084, 1235, 2000, 2047, 2048,
  ],
  lipids: [
    1253, 1257, 1258, 1259, 1260, 1261, 1262, 1263, 1264, 1265, 1266, 1267, 1268, 1269, 1270, 1271,
    1272, 1275, 1276, 1277, 1278, 1279, 1280, 1283, 1292, 1293,
  ],
  minerals: [
    1087, 1088, 1089, 1090, 1091, 1092, 1093, 1094, 1095, 1096, 1097, 1098, 1099, 1100, 1101, 1102,
    1103, 1137, 1146,
  ],
  vitamins: [
    1104, 1105, 1106, 1107, 1108, 1109, 1110, 1111, 1112, 1114, 1120, 1122, 1123, 1125, 1126, 1127,
    1128, 1129, 1130, 1131, 1162, 1165, 1166, 1167, 1170, 1175, 1176, 1177, 1178, 1180, 1181, 1183,
    1184, 1185, 1186, 1187, 1190, 1242, 1246,
  ],
  amino_acids: [
    1210, 1211, 1212, 1213, 1214, 1215, 1216, 1217, 1218, 1219, 1220, 1221, 1222, 1223, 1224, 1225,
    1226, 1227, 1228, 1232,
  ],
  other: [
    1002, 1018, 1024, 1025, 1026, 1032, 1038, 1039, 1041, 1042, 1046, 1053, 1198, 1234, 1340, 1341,
    1342, 1343, 2057,
  ],
};

describe('rows carried over from 0.2.2', () => {
  it('keeps every 0.2.2 row in its 0.2.2 category', () => {
    const moved = Object.entries(CATEGORY_0_2_2).flatMap(([category, ids]) =>
      ids
        .filter((id) => NUTRIENT_BY_ID.get(id)?.category !== category)
        .map((id) => `${id}: ${NUTRIENT_BY_ID.get(id)?.category ?? 'missing'}, was ${category}`),
    );
    expect(moved).toEqual([]);
  });

  it('keeps the rows no sampled food reports', () => {
    const retained = [1025, 1026, 1038, 1042, 1046, 1053, 1342, 1343].map((id) => [
      id,
      NUTRIENT_BY_ID.get(id)?.category,
    ]);
    expect(retained).toEqual([
      [1025, 'other'],
      [1026, 'other'],
      [1038, 'other'],
      [1042, 'other'],
      [1046, 'other'],
      [1053, 'other'],
      [1342, 'other'],
      [1343, 'other'],
    ]);
  });
});

describe('NUTRIENT_BY_ID', () => {
  it('indexes every row — no id is shadowed by a later duplicate', () => {
    expect(NUTRIENT_BY_ID.size).toBe(NUTRIENT_REFERENCE.length);
  });

  it('round-trips each row by its own id', () => {
    const mismatched = NUTRIENT_REFERENCE.filter((n) => NUTRIENT_BY_ID.get(n.id) !== n);
    expect(mismatched).toEqual([]);
  });
});

describe('NUTRIENT_REFERENCE', () => {
  // The count README.md and docs/design.md state; a row lost from the generator's inputs changes it.
  it('holds 269 rows', () => {
    expect(NUTRIENT_REFERENCE).toHaveLength(269);
  });

  it('populates every declared category', () => {
    const empty = CATEGORIES.filter((c) => !NUTRIENT_REFERENCE.some((n) => n.category === c));
    expect(empty).toEqual([]);
  });

  it('assigns every row to a declared category', () => {
    const stray = NUTRIENT_REFERENCE.filter((n) => !CATEGORIES.includes(n.category));
    expect(stray).toEqual([]);
  });

  it('copies id, name, number, and unit from nutrient.csv verbatim', () => {
    const drifted = NUTRIENT_REFERENCE.filter(
      (n) =>
        !DICTIONARY_LINES.get(n.id)?.startsWith(`"${n.id}","${n.name}","${n.unit}","${n.number}",`),
    );
    expect(drifted).toEqual([]);
  });

  it('carries the nutrients the 0.2.2 table lacked', () => {
    const rows = [1062, 1085, 1086, 1113, 1119, 1121, 1158, 1194, 1329, 2033, 2068].map((id) =>
      NUTRIENT_BY_ID.get(id),
    );
    expect(rows).toEqual([
      { id: 1062, name: 'Energy', number: '268', unit: 'kJ', category: 'macronutrients' },
      { id: 1085, name: 'Total fat (NLEA)', number: '298', unit: 'G', category: 'macronutrients' },
      {
        id: 1086,
        name: 'Total sugar alcohols',
        number: '299',
        unit: 'G',
        category: 'macronutrients',
      },
      {
        id: 1113,
        name: '25-hydroxycholecalciferol',
        number: '327',
        unit: 'UG',
        category: 'vitamins',
      },
      { id: 1119, name: 'Zeaxanthin', number: '338.2', unit: 'UG', category: 'vitamins' },
      { id: 1121, name: 'Lutein', number: '338.1', unit: 'UG', category: 'vitamins' },
      { id: 1158, name: 'Vitamin E', number: '394', unit: 'MG_ATE', category: 'vitamins' },
      { id: 1194, name: 'Choline, free', number: '450', unit: 'MG', category: 'vitamins' },
      {
        id: 1329,
        name: 'Fatty acids, total trans-monoenoic',
        number: '693',
        unit: 'G',
        category: 'lipids',
      },
      {
        id: 2033,
        name: 'Total dietary fiber (AOAC 2011.25)',
        number: '293',
        unit: 'G',
        category: 'macronutrients',
      },
      { id: 2068, name: 'Vitamin E', number: '959', unit: 'MG', category: 'vitamins' },
    ]);
  });

  it('omits 2066, which FDC ships only as amount-less rows and its dictionary lacks', () => {
    expect(DICTIONARY_LINES.has(2066)).toBe(false);
    expect(NUTRIENT_BY_ID.has(2066)).toBe(false);
  });

  it('groups rows by category and orders each group by FDC rank', () => {
    const groups = NUTRIENT_REFERENCE.map((n) => n.category).filter(
      (category, i, all) => category !== all[i - 1],
    );
    expect(groups).toEqual(CATEGORIES);

    const outOfOrder = NUTRIENT_REFERENCE.flatMap((n, i) => {
      const prev = NUTRIENT_REFERENCE[i - 1];
      return prev?.category === n.category && rankOf(prev.id) > rankOf(n.id)
        ? [`${prev.id} before ${n.id}`]
        : [];
    });
    expect(outOfOrder).toEqual([]);
  });
});

describe('generated module', () => {
  const { dictionaryCsv: csv, manifest } = readGeneratorInputs();

  it('holds the rows its checked-in inputs generate', () => {
    expect(buildNutrientRows(csv, manifest.nutrients)).toEqual(NUTRIENT_REFERENCE);
  });

  it('equals a fresh generation, byte for byte', () => {
    const fresh = renderNutrientReferenceModule(
      buildNutrientRows(csv, manifest.nutrients),
      manifest,
    );
    expect(readFileSync(MODULE_PATH, 'utf8')).toBe(fresh);
  });

  it('lists exactly the reported and retained IDs', () => {
    const listed = manifest.nutrients.map((n) => n.id).sort((a, b) => a - b);
    expect(NUTRIENT_REFERENCE.map((n) => n.id).sort((a, b) => a - b)).toEqual(listed);
  });
});

describe('buildNutrientRows', () => {
  it('maps each FDC rank band to its category', () => {
    const bands = [
      [50, 'macronutrients'],
      [2849.9, 'macronutrients'],
      [2850, 'other'],
      [5199, 'other'],
      [5200, 'minerals'],
      [6249, 'minerals'],
      [6250, 'vitamins'],
      [9599, 'vitamins'],
      [9600, 'lipids'],
      [16249, 'lipids'],
      [16250, 'amino_acids'],
      [18199, 'amino_acids'],
      [18200, 'other'],
      [19330, 'other'],
    ] as const;
    const ids = bands.map((_, i) => 90_001 + i);
    const csv = dictionaryCsv(bands.map(([rank], i) => [90_001 + i, `N${i}`, 'G', '', `${rank}`]));

    const byId = new Map(buildNutrientRows(csv, reported(...ids)).map((n) => [n.id, n.category]));
    expect(ids.map((id) => byId.get(id))).toEqual(bands.map(([, category]) => category));
  });

  it('applies an override before the rank band and to unranked rows', () => {
    const csv = dictionaryCsv([
      [2069, 'Glutathione', 'MG', '961', '9000'],
      [1086, 'Total sugar alcohols', 'G', '299', '999999.0'],
      [1072, 'Carbohydrate, other', 'G', '284', ''],
    ]);

    expect(buildNutrientRows(csv, reported(2069, 1086, 1072))).toEqual([
      {
        id: 1072,
        name: 'Carbohydrate, other',
        number: '284',
        unit: 'G',
        category: 'macronutrients',
      },
      {
        id: 1086,
        name: 'Total sugar alcohols',
        number: '299',
        unit: 'G',
        category: 'macronutrients',
      },
      { id: 2069, name: 'Glutathione', number: '961', unit: 'MG', category: 'other' },
    ]);
  });

  it('orders by category, then rank, then id, with unranked rows last', () => {
    const csv = dictionaryCsv([
      [90_005, 'Late mineral', 'MG', '', '5300'],
      [90_006, 'Tied mineral', 'MG', '', '5250'],
      [1086, 'Total sugar alcohols', 'G', '299', '999999.0'],
      [90_003, 'Lipid', 'G', '', '9700'],
      [90_002, 'Early mineral', 'MG', '', '5250'],
      [90_001, 'Macronutrient', 'G', '', '1000'],
    ]);
    const rows = buildNutrientRows(csv, [
      ...reported(90_006, 1086, 90_003, 90_002, 90_001),
      { id: 90_005, retained: true },
    ]);

    expect(rows.map((n) => n.id)).toEqual([90_001, 1086, 90_003, 90_002, 90_006, 90_005]);
  });

  it('rejects a listed ID with no nutrient.csv row', () => {
    const csv = dictionaryCsv([[90_001, 'Water', 'G', '255', '100']]);
    expect(() => buildNutrientRows(csv, reported(90_001, 90_002))).toThrow(
      'Nutrient 90002 is listed but has no nutrient.csv row',
    );
  });

  it('rejects a listed ID with no category', () => {
    const csv = dictionaryCsv([[90_001, 'Unplaced', 'G', '', '999999.0']]);
    expect(() => buildNutrientRows(csv, reported(90_001))).toThrow(
      'Nutrient 90001 (Unplaced) has no category',
    );
  });

  it('rejects an ID listed twice', () => {
    const csv = dictionaryCsv([[90_001, 'Water', 'G', '255', '100']]);
    expect(() => buildNutrientRows(csv, reported(90_001, 90_001))).toThrow(
      'Nutrient 90001 is listed twice',
    );
  });

  it('rejects a dictionary line that is not five quoted fields', () => {
    const csv = `${dictionaryCsv([[90_001, 'Water', 'G', '255', '100']])}90002,Water,G,255,100\n`;
    expect(() => buildNutrientRows(csv, reported(90_001))).toThrow(
      'nutrient.csv line 3 is not an FDC dictionary row',
    );
  });
});
