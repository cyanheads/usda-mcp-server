/**
 * @fileoverview Static FDC nutrient reference data — all tracked nutrients with IDs, names, units, and categories.
 * @module services/fdc/nutrient-reference
 *
 * `id`, `name`, `number`, and `unit` mirror FoodData Central's own nutrient
 * dictionary (`nutrient.csv`, shipped inside the bulk CSV downloads at
 * https://fdc.nal.usda.gov/download-datasets) verbatim — its `id`, `name`,
 * `nutrient_nbr`, and `unit_name` columns. Only `category` is this server's
 * own grouping. Never edit a row from memory or from a single food's payload;
 * re-derive it from that file.
 *
 * 136 of the 147 rows were also observed live in `foodNutrients[].nutrient`
 * across 597 foods spanning all four FDC data types, each id carrying one
 * consistent (number, name, unitName) triple. Eleven rest on the nutrient
 * dictionary alone, no food in that sample having reported them: Chlorine,
 * Chromium, Inositol, Specific Gravity, Adjusted Protein, Acetic acid, Lactic
 * acid, Phytic acid, Succinic acid, Taurine, Glycitein.
 *
 * Ergothioneine (2057) carries an empty `number` because FDC assigns it no SR
 * reference number — that gap is upstream, not a missing value to fill in.
 */

import type { NutrientCategory, NutrientReference } from './types.js';

/** Complete FDC nutrient reference list, grouped by category in FDC reporting order. */
export const NUTRIENT_REFERENCE: NutrientReference[] = [
  // --- Macronutrients ---
  { id: 1008, name: 'Energy', number: '208', unit: 'KCAL', category: 'macronutrients' },
  {
    id: 2047,
    name: 'Energy (Atwater General Factors)',
    number: '957',
    unit: 'KCAL',
    category: 'macronutrients',
  },
  {
    id: 2048,
    name: 'Energy (Atwater Specific Factors)',
    number: '958',
    unit: 'KCAL',
    category: 'macronutrients',
  },
  { id: 1003, name: 'Protein', number: '203', unit: 'G', category: 'macronutrients' },
  { id: 1004, name: 'Total lipid (fat)', number: '204', unit: 'G', category: 'macronutrients' },
  {
    id: 1005,
    name: 'Carbohydrate, by difference',
    number: '205',
    unit: 'G',
    category: 'macronutrients',
  },
  { id: 1079, name: 'Fiber, total dietary', number: '291', unit: 'G', category: 'macronutrients' },
  { id: 1082, name: 'Fiber, soluble', number: '295', unit: 'G', category: 'macronutrients' },
  { id: 1084, name: 'Fiber, insoluble', number: '297', unit: 'G', category: 'macronutrients' },
  { id: 1063, name: 'Sugars, Total', number: '269.3', unit: 'G', category: 'macronutrients' },
  { id: 1235, name: 'Sugars, added', number: '539', unit: 'G', category: 'macronutrients' },
  {
    id: 1050,
    name: 'Carbohydrate, by summation',
    number: '205.2',
    unit: 'G',
    category: 'macronutrients',
  },
  { id: 1051, name: 'Water', number: '255', unit: 'G', category: 'macronutrients' },
  { id: 1007, name: 'Ash', number: '207', unit: 'G', category: 'macronutrients' },
  { id: 1057, name: 'Caffeine', number: '262', unit: 'MG', category: 'macronutrients' },
  { id: 1058, name: 'Theobromine', number: '263', unit: 'MG', category: 'macronutrients' },
  { id: 1013, name: 'Lactose', number: '213', unit: 'G', category: 'macronutrients' },
  { id: 1014, name: 'Maltose', number: '214', unit: 'G', category: 'macronutrients' },
  { id: 1010, name: 'Sucrose', number: '210', unit: 'G', category: 'macronutrients' },
  { id: 1011, name: 'Glucose', number: '211', unit: 'G', category: 'macronutrients' },
  { id: 1012, name: 'Fructose', number: '212', unit: 'G', category: 'macronutrients' },
  { id: 1075, name: 'Galactose', number: '287', unit: 'G', category: 'macronutrients' },
  { id: 1009, name: 'Starch', number: '209', unit: 'G', category: 'macronutrients' },
  { id: 2000, name: 'Total Sugars', number: '269', unit: 'G', category: 'macronutrients' },

  // --- Lipids ---
  { id: 1258, name: 'Fatty acids, total saturated', number: '606', unit: 'G', category: 'lipids' },
  { id: 1259, name: 'SFA 4:0', number: '607', unit: 'G', category: 'lipids' },
  { id: 1260, name: 'SFA 6:0', number: '608', unit: 'G', category: 'lipids' },
  { id: 1261, name: 'SFA 8:0', number: '609', unit: 'G', category: 'lipids' },
  { id: 1262, name: 'SFA 10:0', number: '610', unit: 'G', category: 'lipids' },
  { id: 1263, name: 'SFA 12:0', number: '611', unit: 'G', category: 'lipids' },
  { id: 1264, name: 'SFA 14:0', number: '612', unit: 'G', category: 'lipids' },
  { id: 1265, name: 'SFA 16:0', number: '613', unit: 'G', category: 'lipids' },
  { id: 1266, name: 'SFA 18:0', number: '614', unit: 'G', category: 'lipids' },
  { id: 1267, name: 'SFA 20:0', number: '615', unit: 'G', category: 'lipids' },
  {
    id: 1292,
    name: 'Fatty acids, total monounsaturated',
    number: '645',
    unit: 'G',
    category: 'lipids',
  },
  { id: 1275, name: 'MUFA 16:1', number: '626', unit: 'G', category: 'lipids' },
  { id: 1268, name: 'MUFA 18:1', number: '617', unit: 'G', category: 'lipids' },
  { id: 1277, name: 'MUFA 20:1', number: '628', unit: 'G', category: 'lipids' },
  { id: 1279, name: 'MUFA 22:1', number: '630', unit: 'G', category: 'lipids' },
  {
    id: 1293,
    name: 'Fatty acids, total polyunsaturated',
    number: '646',
    unit: 'G',
    category: 'lipids',
  },
  { id: 1269, name: 'PUFA 18:2', number: '618', unit: 'G', category: 'lipids' },
  { id: 1270, name: 'PUFA 18:3', number: '619', unit: 'G', category: 'lipids' },
  { id: 1276, name: 'PUFA 18:4', number: '627', unit: 'G', category: 'lipids' },
  { id: 1271, name: 'PUFA 20:4', number: '620', unit: 'G', category: 'lipids' },
  { id: 1278, name: 'PUFA 20:5 n-3 (EPA)', number: '629', unit: 'G', category: 'lipids' },
  { id: 1280, name: 'PUFA 22:5 n-3 (DPA)', number: '631', unit: 'G', category: 'lipids' },
  { id: 1272, name: 'PUFA 22:6 n-3 (DHA)', number: '621', unit: 'G', category: 'lipids' },
  { id: 1257, name: 'Fatty acids, total trans', number: '605', unit: 'G', category: 'lipids' },
  { id: 1253, name: 'Cholesterol', number: '601', unit: 'MG', category: 'lipids' },
  { id: 1283, name: 'Phytosterols', number: '636', unit: 'MG', category: 'lipids' },

  // --- Minerals ---
  { id: 1087, name: 'Calcium, Ca', number: '301', unit: 'MG', category: 'minerals' },
  { id: 1088, name: 'Chlorine, Cl', number: '302', unit: 'MG', category: 'minerals' },
  { id: 1089, name: 'Iron, Fe', number: '303', unit: 'MG', category: 'minerals' },
  { id: 1090, name: 'Magnesium, Mg', number: '304', unit: 'MG', category: 'minerals' },
  { id: 1091, name: 'Phosphorus, P', number: '305', unit: 'MG', category: 'minerals' },
  { id: 1092, name: 'Potassium, K', number: '306', unit: 'MG', category: 'minerals' },
  { id: 1093, name: 'Sodium, Na', number: '307', unit: 'MG', category: 'minerals' },
  { id: 1094, name: 'Sulfur, S', number: '308', unit: 'MG', category: 'minerals' },
  { id: 1095, name: 'Zinc, Zn', number: '309', unit: 'MG', category: 'minerals' },
  { id: 1096, name: 'Chromium, Cr', number: '310', unit: 'UG', category: 'minerals' },
  { id: 1097, name: 'Cobalt, Co', number: '311', unit: 'UG', category: 'minerals' },
  { id: 1098, name: 'Copper, Cu', number: '312', unit: 'MG', category: 'minerals' },
  { id: 1099, name: 'Fluoride, F', number: '313', unit: 'UG', category: 'minerals' },
  { id: 1100, name: 'Iodine, I', number: '314', unit: 'UG', category: 'minerals' },
  { id: 1101, name: 'Manganese, Mn', number: '315', unit: 'MG', category: 'minerals' },
  { id: 1102, name: 'Molybdenum, Mo', number: '316', unit: 'UG', category: 'minerals' },
  { id: 1103, name: 'Selenium, Se', number: '317', unit: 'UG', category: 'minerals' },
  { id: 1137, name: 'Boron, B', number: '354', unit: 'UG', category: 'minerals' },
  { id: 1146, name: 'Nickel, Ni', number: '371', unit: 'UG', category: 'minerals' },

  // --- Vitamins ---
  { id: 1106, name: 'Vitamin A, RAE', number: '320', unit: 'UG', category: 'vitamins' },
  { id: 1107, name: 'Carotene, beta', number: '321', unit: 'UG', category: 'vitamins' },
  { id: 1108, name: 'Carotene, alpha', number: '322', unit: 'UG', category: 'vitamins' },
  {
    id: 1109,
    name: 'Vitamin E (alpha-tocopherol)',
    number: '323',
    unit: 'MG',
    category: 'vitamins',
  },
  {
    id: 1110,
    name: 'Vitamin D (D2 + D3), International Units',
    number: '324',
    unit: 'IU',
    category: 'vitamins',
  },
  {
    id: 1111,
    name: 'Vitamin D2 (ergocalciferol)',
    number: '325',
    unit: 'UG',
    category: 'vitamins',
  },
  {
    id: 1112,
    name: 'Vitamin D3 (cholecalciferol)',
    number: '326',
    unit: 'UG',
    category: 'vitamins',
  },
  { id: 1114, name: 'Vitamin D (D2 + D3)', number: '328', unit: 'UG', category: 'vitamins' },
  { id: 1120, name: 'Cryptoxanthin, beta', number: '334', unit: 'UG', category: 'vitamins' },
  { id: 1122, name: 'Lycopene', number: '337', unit: 'UG', category: 'vitamins' },
  { id: 1123, name: 'Lutein + zeaxanthin', number: '338', unit: 'UG', category: 'vitamins' },
  {
    id: 1162,
    name: 'Vitamin C, total ascorbic acid',
    number: '401',
    unit: 'MG',
    category: 'vitamins',
  },
  { id: 1165, name: 'Thiamin', number: '404', unit: 'MG', category: 'vitamins' },
  { id: 1166, name: 'Riboflavin', number: '405', unit: 'MG', category: 'vitamins' },
  { id: 1167, name: 'Niacin', number: '406', unit: 'MG', category: 'vitamins' },
  { id: 1170, name: 'Pantothenic acid', number: '410', unit: 'MG', category: 'vitamins' },
  { id: 1175, name: 'Vitamin B-6', number: '415', unit: 'MG', category: 'vitamins' },
  { id: 1176, name: 'Biotin', number: '416', unit: 'UG', category: 'vitamins' },
  { id: 1177, name: 'Folate, total', number: '417', unit: 'UG', category: 'vitamins' },
  { id: 1178, name: 'Vitamin B-12', number: '418', unit: 'UG', category: 'vitamins' },
  { id: 1180, name: 'Choline, total', number: '421', unit: 'MG', category: 'vitamins' },
  { id: 1181, name: 'Inositol', number: '422', unit: 'MG', category: 'vitamins' },
  { id: 1185, name: 'Vitamin K (phylloquinone)', number: '430', unit: 'UG', category: 'vitamins' },
  { id: 1183, name: 'Vitamin K (Menaquinone-4)', number: '428', unit: 'UG', category: 'vitamins' },
  {
    id: 1184,
    name: 'Vitamin K (Dihydrophylloquinone)',
    number: '429',
    unit: 'UG',
    category: 'vitamins',
  },
  { id: 1186, name: 'Folic acid', number: '431', unit: 'UG', category: 'vitamins' },
  { id: 1187, name: 'Folate, food', number: '432', unit: 'UG', category: 'vitamins' },
  { id: 1190, name: 'Folate, DFE', number: '435', unit: 'UG', category: 'vitamins' },
  { id: 1104, name: 'Vitamin A, IU', number: '318', unit: 'IU', category: 'vitamins' },
  { id: 1242, name: 'Vitamin E, added', number: '573', unit: 'MG', category: 'vitamins' },
  { id: 1246, name: 'Vitamin B-12, added', number: '578', unit: 'UG', category: 'vitamins' },
  { id: 1105, name: 'Retinol', number: '319', unit: 'UG', category: 'vitamins' },
  { id: 1125, name: 'Tocopherol, beta', number: '341', unit: 'MG', category: 'vitamins' },
  { id: 1126, name: 'Tocopherol, gamma', number: '342', unit: 'MG', category: 'vitamins' },
  { id: 1127, name: 'Tocopherol, delta', number: '343', unit: 'MG', category: 'vitamins' },
  { id: 1128, name: 'Tocotrienol, alpha', number: '344', unit: 'MG', category: 'vitamins' },
  { id: 1129, name: 'Tocotrienol, beta', number: '345', unit: 'MG', category: 'vitamins' },
  { id: 1130, name: 'Tocotrienol, gamma', number: '346', unit: 'MG', category: 'vitamins' },
  { id: 1131, name: 'Tocotrienol, delta', number: '347', unit: 'MG', category: 'vitamins' },

  // --- Amino Acids ---
  { id: 1210, name: 'Tryptophan', number: '501', unit: 'G', category: 'amino_acids' },
  { id: 1211, name: 'Threonine', number: '502', unit: 'G', category: 'amino_acids' },
  { id: 1212, name: 'Isoleucine', number: '503', unit: 'G', category: 'amino_acids' },
  { id: 1213, name: 'Leucine', number: '504', unit: 'G', category: 'amino_acids' },
  { id: 1214, name: 'Lysine', number: '505', unit: 'G', category: 'amino_acids' },
  { id: 1215, name: 'Methionine', number: '506', unit: 'G', category: 'amino_acids' },
  { id: 1216, name: 'Cystine', number: '507', unit: 'G', category: 'amino_acids' },
  { id: 1217, name: 'Phenylalanine', number: '508', unit: 'G', category: 'amino_acids' },
  { id: 1218, name: 'Tyrosine', number: '509', unit: 'G', category: 'amino_acids' },
  { id: 1219, name: 'Valine', number: '510', unit: 'G', category: 'amino_acids' },
  { id: 1220, name: 'Arginine', number: '511', unit: 'G', category: 'amino_acids' },
  { id: 1221, name: 'Histidine', number: '512', unit: 'G', category: 'amino_acids' },
  { id: 1222, name: 'Alanine', number: '513', unit: 'G', category: 'amino_acids' },
  { id: 1223, name: 'Aspartic acid', number: '514', unit: 'G', category: 'amino_acids' },
  { id: 1224, name: 'Glutamic acid', number: '515', unit: 'G', category: 'amino_acids' },
  { id: 1225, name: 'Glycine', number: '516', unit: 'G', category: 'amino_acids' },
  { id: 1226, name: 'Proline', number: '517', unit: 'G', category: 'amino_acids' },
  { id: 1227, name: 'Serine', number: '518', unit: 'G', category: 'amino_acids' },
  { id: 1228, name: 'Hydroxyproline', number: '521', unit: 'G', category: 'amino_acids' },
  { id: 1232, name: 'Cysteine', number: '526', unit: 'G', category: 'amino_acids' },

  // --- Other ---
  { id: 1002, name: 'Nitrogen', number: '202', unit: 'G', category: 'other' },
  { id: 1024, name: 'Specific Gravity', number: '227', unit: 'SP_GR', category: 'other' },
  { id: 1018, name: 'Alcohol, ethyl', number: '221', unit: 'G', category: 'other' },
  { id: 1053, name: 'Adjusted Protein', number: '257', unit: 'G', category: 'other' },
  { id: 1025, name: 'Organic acids', number: '229', unit: 'G', category: 'other' },
  { id: 1026, name: 'Acetic acid', number: '230', unit: 'MG', category: 'other' },
  { id: 1198, name: 'Betaine', number: '454', unit: 'MG', category: 'other' },
  { id: 1032, name: 'Citric acid', number: '236', unit: 'MG', category: 'other' },
  { id: 1038, name: 'Lactic acid', number: '242', unit: 'MG', category: 'other' },
  { id: 1039, name: 'Malic acid', number: '243', unit: 'MG', category: 'other' },
  { id: 1041, name: 'Oxalic acid', number: '245', unit: 'MG', category: 'other' },
  { id: 1042, name: 'Phytic acid', number: '246', unit: 'MG', category: 'other' },
  { id: 1046, name: 'Succinic acid', number: '250', unit: 'MG', category: 'other' },
  { id: 1234, name: 'Taurine', number: '529', unit: 'G', category: 'other' },
  { id: 1340, name: 'Daidzein', number: '710', unit: 'MG', category: 'other' },
  { id: 1341, name: 'Genistein', number: '711', unit: 'MG', category: 'other' },
  { id: 1342, name: 'Glycitein', number: '712', unit: 'MG', category: 'other' },
  { id: 1343, name: 'Isoflavones', number: '713', unit: 'MG', category: 'other' },
  { id: 2057, name: 'Ergothioneine', number: '', unit: 'MG', category: 'other' },
];

/** Build a lookup map from ID to nutrient reference for O(1) access. */
export const NUTRIENT_BY_ID: Map<number, NutrientReference> = new Map(
  NUTRIENT_REFERENCE.map((n) => [n.id, n]),
);

/** Filter the reference list by category. */
export function getNutrientsByCategory(category?: NutrientCategory): NutrientReference[] {
  if (!category) return NUTRIENT_REFERENCE;
  return NUTRIENT_REFERENCE.filter((n) => n.category === category);
}
