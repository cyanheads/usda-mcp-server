/**
 * @fileoverview Stand-in for the USDA FoodData Central API over the framework's
 * fetch harness, for tests that exercise the real `FdcService` instead of
 * mocking it. It reproduces the one upstream rule local normalization has to
 * agree with: the `nutrients` filter matches SR **numbers** (`"208"`), never FDC
 * nutrient **ids** (`1008`), and an unmatched filter yields an empty
 * `foodNutrients[]` rather than an error.
 *
 * Fixture values are real FDC responses, trimmed to the fields the service
 * reads. Kale and Spinach carry the same twelve nutrients, Total Sugars (2000)
 * among them, and neither carries Sugars, Total (1063) — matching FDC, where
 * 1063 is effectively Foundation-only. That gives tests a nutrient that is
 * genuinely absent rather than filtered out, without pretending these foods
 * have no sugars data at all. The other fixtures cover the record shapes each
 * data type sends: Branded volume labels, GTINs, and `brandedFoodCategory`;
 * FNDDS `portionDescription`, food-code modifiers, and `wweiaFoodCategory`;
 * SR Legacy and Foundation portion amounts and measure units; Foundation
 * records that report energy only as Atwater estimates (2047, 2048) and
 * sugars only as 1063; Branded labels in GRM and in IU.
 * @module tests/fdc-fake
 */

import { createFetchMock, type FetchMockHarness } from '@cyanheads/mcp-ts-core/testing';
import type { RawFoodDetail } from '@/services/fdc/types.js';

const BASE_PATH = '/fdc/v1';

/** FDC's placeholder measure unit on SR Legacy and FNDDS portions. */
const UNDETERMINED = { id: 9999, name: 'undetermined', abbreviation: 'undetermined' };

/** Kale, raw (SR Legacy) — a subset of the 112 nutrients FDC returns. */
export const RAW_KALE: RawFoodDetail = {
  fdcId: 168421,
  description: 'Kale, raw',
  dataType: 'SR Legacy',
  publicationDate: '4/1/2019',
  foodCategory: { description: 'Vegetables and Vegetable Products' },
  foodPortions: [{ amount: 1, gramWeight: 21, modifier: 'cup', measureUnit: UNDETERMINED }],
  foodNutrients: [
    { nutrient: { id: 1008, number: '208', name: 'Energy', unitName: 'kcal' }, amount: 35 },
    { nutrient: { id: 1003, number: '203', name: 'Protein', unitName: 'g' }, amount: 2.92 },
    {
      nutrient: { id: 1004, number: '204', name: 'Total lipid (fat)', unitName: 'g' },
      amount: 1.49,
    },
    {
      nutrient: { id: 1005, number: '205', name: 'Carbohydrate, by difference', unitName: 'g' },
      amount: 4.42,
    },
    {
      nutrient: { id: 1079, number: '291', name: 'Fiber, total dietary', unitName: 'g' },
      amount: 4.1,
    },
    {
      nutrient: { id: 1258, number: '606', name: 'Fatty acids, total saturated', unitName: 'g' },
      amount: 0.178,
    },
    { nutrient: { id: 1093, number: '307', name: 'Sodium, Na', unitName: 'mg' }, amount: 53 },
    { nutrient: { id: 1092, number: '306', name: 'Potassium, K', unitName: 'mg' }, amount: 348 },
    { nutrient: { id: 1087, number: '301', name: 'Calcium, Ca', unitName: 'mg' }, amount: 254 },
    { nutrient: { id: 1089, number: '303', name: 'Iron, Fe', unitName: 'mg' }, amount: 1.6 },
    { nutrient: { id: 2000, number: '269', name: 'Total Sugars', unitName: 'g' }, amount: 0.99 },
    {
      nutrient: {
        id: 1162,
        number: '401',
        name: 'Vitamin C, total ascorbic acid',
        unitName: 'mg',
      },
      amount: 93.4,
    },
  ],
};

const kaleNutrients = RAW_KALE.foodNutrients;
if (!kaleNutrients) throw new Error('RAW_KALE fixture must declare foodNutrients');

/** How many nutrients Kale and Spinach each carry — the unfiltered result size. */
export const FIXTURE_NUTRIENT_COUNT = kaleNutrients.length;

/** Spinach, raw (SR Legacy) — same nutrient set as {@link RAW_KALE}. */
export const RAW_SPINACH: RawFoodDetail = {
  fdcId: 168462,
  description: 'Spinach, raw',
  dataType: 'SR Legacy',
  publicationDate: '4/1/2019',
  foodCategory: { description: 'Vegetables and Vegetable Products' },
  foodPortions: [
    { amount: 1, gramWeight: 340, modifier: 'bunch', measureUnit: UNDETERMINED },
    { amount: 1, gramWeight: 10, modifier: 'leaf', measureUnit: UNDETERMINED },
  ],
  foodNutrients: [
    { nutrient: { id: 1008, number: '208', name: 'Energy', unitName: 'kcal' }, amount: 23 },
    { nutrient: { id: 1003, number: '203', name: 'Protein', unitName: 'g' }, amount: 2.86 },
    {
      nutrient: { id: 1004, number: '204', name: 'Total lipid (fat)', unitName: 'g' },
      amount: 0.39,
    },
    {
      nutrient: { id: 1005, number: '205', name: 'Carbohydrate, by difference', unitName: 'g' },
      amount: 3.63,
    },
    {
      nutrient: { id: 1079, number: '291', name: 'Fiber, total dietary', unitName: 'g' },
      amount: 2.2,
    },
    {
      nutrient: { id: 1258, number: '606', name: 'Fatty acids, total saturated', unitName: 'g' },
      amount: 0.063,
    },
    { nutrient: { id: 1093, number: '307', name: 'Sodium, Na', unitName: 'mg' }, amount: 79 },
    { nutrient: { id: 1092, number: '306', name: 'Potassium, K', unitName: 'mg' }, amount: 558 },
    { nutrient: { id: 1087, number: '301', name: 'Calcium, Ca', unitName: 'mg' }, amount: 99 },
    { nutrient: { id: 1089, number: '303', name: 'Iron, Fe', unitName: 'mg' }, amount: 2.71 },
    { nutrient: { id: 2000, number: '269', name: 'Total Sugars', unitName: 'g' }, amount: 0.42 },
    {
      nutrient: {
        id: 1162,
        number: '401',
        name: 'Vitamin C, total ascorbic acid',
        unitName: 'mg',
      },
      amount: 28.1,
    },
  ],
};

/** Egg custard (SR Legacy) — its one portion weighs half a cup. */
export const RAW_CUSTARD: RawFoodDetail = {
  fdcId: 168787,
  description: 'Egg custards, dry mix, prepared with 2% milk',
  dataType: 'SR Legacy',
  publicationDate: '4/1/2019',
  foodCategory: { description: 'Sweets' },
  foodPortions: [{ amount: 0.5, gramWeight: 141, modifier: 'cup', measureUnit: UNDETERMINED }],
  foodNutrients: [
    { nutrient: { id: 1008, number: '208', name: 'Energy', unitName: 'kcal' }, amount: 112 },
    { nutrient: { id: 1003, number: '203', name: 'Protein', unitName: 'g' }, amount: 4.13 },
  ],
};

/** Spinach egg noodles (SR Legacy) — FDC lists the 2 oz portion before the cup. */
export const RAW_NOODLES: RawFoodDetail = {
  fdcId: 169733,
  description: 'Noodles, egg, spinach, enriched, dry',
  dataType: 'SR Legacy',
  publicationDate: '4/1/2019',
  foodCategory: { description: 'Cereal Grains and Pasta' },
  foodPortions: [
    { amount: 2, gramWeight: 57, modifier: 'oz', measureUnit: UNDETERMINED, sequenceNumber: 2 },
    { amount: 1, gramWeight: 38, modifier: 'cup', measureUnit: UNDETERMINED, sequenceNumber: 1 },
  ],
  foodNutrients: [
    { nutrient: { id: 1008, number: '208', name: 'Energy', unitName: 'kcal' }, amount: 382 },
    { nutrient: { id: 1003, number: '203', name: 'Protein', unitName: 'g' }, amount: 14.61 },
  ],
};

/** Navel oranges (Foundation) — real measure units, a padded modifier, and a RACC. */
export const RAW_ORANGE: RawFoodDetail = {
  fdcId: 746771,
  description: 'Oranges, raw, navels',
  dataType: 'Foundation',
  publicationDate: '12/16/2019',
  foodCategory: { description: 'Fruits and Fruit Juices' },
  foodPortions: [
    {
      amount: 1,
      gramWeight: 165,
      modifier: 'sections no membranes',
      measureUnit: { id: 1000, name: 'cup', abbreviation: 'cup' },
    },
    {
      amount: 1,
      gramWeight: 140,
      modifier: ' 2-7/8" dia',
      measureUnit: { id: 1071, name: 'each', abbreviation: 'each' },
    },
    { amount: 1, gramWeight: 140, measureUnit: { id: 1121, name: 'RACC', abbreviation: 'RACC' } },
  ],
  foodNutrients: [
    { nutrient: { id: 1008, number: '208', name: 'Energy', unitName: 'kcal' }, amount: 47 },
  ],
};

/** A beef taco (Survey (FNDDS)) — described portions, food-code modifiers, a WWEIA category. */
export const RAW_TACO: RawFoodDetail = {
  fdcId: 2708522,
  description: 'Taco, flour tortilla, beef, cheese',
  dataType: 'Survey (FNDDS)',
  publicationDate: '10/31/2024',
  wweiaFoodCategory: {
    wweiaFoodCategoryCode: 3304592,
    wweiaFoodCategoryDescription: 'Burritos and tacos',
  },
  foodPortions: [
    {
      gramWeight: 105,
      modifier: '64772',
      portionDescription: '1 small/regular',
      measureUnit: UNDETERMINED,
    },
    {
      gramWeight: 160,
      modifier: '60919',
      portionDescription: '1 large',
      measureUnit: UNDETERMINED,
    },
    {
      gramWeight: 105,
      modifier: '90000',
      portionDescription: 'Quantity not specified',
      measureUnit: UNDETERMINED,
    },
  ],
  foodNutrients: [
    { nutrient: { id: 1008, number: '208', name: 'Energy', unitName: 'kcal' }, amount: 257 },
    { nutrient: { id: 1003, number: '203', name: 'Protein', unitName: 'g' }, amount: 16.7 },
  ],
};

/** Winn-Dixie milk (Branded) — a 240 ml label, so FDC reports it per 100 ml. */
export const RAW_MILK: RawFoodDetail = {
  fdcId: 2078244,
  description: 'MILK',
  dataType: 'Branded',
  publicationDate: '10/28/2021',
  brandOwner: 'Winn-Dixie Stores, Inc.',
  brandName: 'WINN-DIXIE',
  brandedFoodCategory: 'Milk',
  gtinUpc: '02114029705',
  ingredients: 'MILK, VITAMIN D3.',
  servingSize: 240,
  servingSizeUnit: 'ml',
  householdServingFullText: '1 cup',
  foodPortions: [],
  foodNutrients: [
    { nutrient: { id: 1087, number: '301', name: 'Calcium, Ca', unitName: 'mg' }, amount: 125 },
    { nutrient: { id: 1008, number: '208', name: 'Energy', unitName: 'kcal' }, amount: 62 },
  ],
};

/** Kroger olive oil (Branded) — a 15 ml label, per 100 ml like {@link RAW_MILK}. */
export const RAW_OLIVE_OIL: RawFoodDetail = {
  fdcId: 2151571,
  description: 'EXTRA VIRGIN OLIVE OIL, EXTRA VIRGIN',
  dataType: 'Branded',
  publicationDate: '10/28/2021',
  brandOwner: 'The Kroger Co.',
  brandName: 'KROGER',
  brandedFoodCategory: 'Vegetable & Cooking Oils',
  gtinUpc: '011110044174',
  ingredients: 'EXTRA VIRGIN OLIVE OIL.',
  servingSize: 15,
  servingSizeUnit: 'ml',
  householdServingFullText: '1 Tbsp',
  foodPortions: [],
  foodNutrients: [
    { nutrient: { id: 1008, number: '208', name: 'Energy', unitName: 'kcal' }, amount: 800 },
    {
      nutrient: { id: 1004, number: '204', name: 'Total lipid (fat)', unitName: 'g' },
      amount: 93.33,
    },
  ],
};

/** A detail-shaped nutrient entry, for the fixtures below that carry a full comparison set. */
function nutrient(id: number, number: string, name: string, unitName: string, amount: number) {
  return { nutrient: { id, number, name, unitName }, amount };
}

/**
 * Broccoli, raw (Foundation) — reports Energy as 1008 but sugars only as
 * Sugars, Total (1063), never Total Sugars (2000).
 */
export const RAW_BROCCOLI: RawFoodDetail = {
  fdcId: 747447,
  description: 'Broccoli, raw',
  dataType: 'Foundation',
  publicationDate: '12/16/2019',
  foodCategory: { description: 'Vegetables and Vegetable Products' },
  foodPortions: [
    {
      amount: 1,
      gramWeight: 76,
      modifier: 'chopped',
      measureUnit: { id: 1000, name: 'cup', abbreviation: 'cup' },
    },
  ],
  foodNutrients: [
    nutrient(1008, '208', 'Energy', 'kcal', 31),
    nutrient(1003, '203', 'Protein', 'g', 2.57),
    nutrient(1004, '204', 'Total lipid (fat)', 'g', 0.34),
    nutrient(1005, '205', 'Carbohydrate, by difference', 'g', 6.27),
    nutrient(1079, '291', 'Fiber, total dietary', 'g', 2.4),
    nutrient(1063, '269.3', 'Sugars, Total', 'g', 1.4),
    nutrient(1087, '301', 'Calcium, Ca', 'mg', 46),
    nutrient(1089, '303', 'Iron, Fe', 'mg', 0.69),
    nutrient(1092, '306', 'Potassium, K', 'mg', 303),
    nutrient(1093, '307', 'Sodium, Na', 'mg', 36),
    nutrient(1162, '401', 'Vitamin C, total ascorbic acid', 'mg', 91.3),
    nutrient(1258, '606', 'Fatty acids, total saturated', 'g', 0.039),
  ],
};

/** Broccoli, raw (SR Legacy) — the same food as {@link RAW_BROCCOLI}, with all twelve compare defaults. */
export const RAW_BROCCOLI_SR: RawFoodDetail = {
  fdcId: 170379,
  description: 'Broccoli, raw',
  dataType: 'SR Legacy',
  publicationDate: '4/1/2019',
  foodCategory: { description: 'Vegetables and Vegetable Products' },
  foodPortions: [
    { amount: 0.5, gramWeight: 44, modifier: 'cup, chopped or diced', measureUnit: UNDETERMINED },
  ],
  foodNutrients: [
    nutrient(1008, '208', 'Energy', 'kcal', 34),
    nutrient(1003, '203', 'Protein', 'g', 2.82),
    nutrient(1004, '204', 'Total lipid (fat)', 'g', 0.37),
    nutrient(1005, '205', 'Carbohydrate, by difference', 'g', 6.64),
    nutrient(1079, '291', 'Fiber, total dietary', 'g', 2.6),
    nutrient(2000, '269', 'Total Sugars', 'g', 1.7),
    nutrient(1087, '301', 'Calcium, Ca', 'mg', 47),
    nutrient(1089, '303', 'Iron, Fe', 'mg', 0.73),
    nutrient(1092, '306', 'Potassium, K', 'mg', 316),
    nutrient(1093, '307', 'Sodium, Na', 'mg', 33),
    nutrient(1162, '401', 'Vitamin C, total ascorbic acid', 'mg', 89.2),
    nutrient(1258, '606', 'Fatty acids, total saturated', 'g', 0.114),
  ],
};

/**
 * Flour, 00 (Foundation) — energy only as the Atwater estimates 2047 and 2048,
 * and no sugars under either id.
 */
export const RAW_FLOUR: RawFoodDetail = {
  fdcId: 2003586,
  description: 'Flour, 00',
  dataType: 'Foundation',
  publicationDate: '10/28/2021',
  foodCategory: { description: 'Cereal Grains and Pasta' },
  foodPortions: [
    { amount: 1, gramWeight: 30, measureUnit: { id: 1121, name: 'RACC', abbreviation: 'RACC' } },
  ],
  foodNutrients: [
    nutrient(2047, '957', 'Energy (Atwater General Factors)', 'kcal', 357.0648),
    nutrient(2048, '958', 'Energy (Atwater Specific Factors)', 'kcal', 365.610744),
    nutrient(1003, '203', 'Protein', 'g', 11.4),
    nutrient(1004, '204', 'Total lipid (fat)', 'g', 1.52),
    nutrient(1005, '205', 'Carbohydrate, by difference', 'g', 74.4462),
    nutrient(1079, '291', 'Fiber, total dietary', 'g', 2.656),
    nutrient(1087, '301', 'Calcium, Ca', 'mg', 18.68),
    nutrient(1089, '303', 'Iron, Fe', 'mg', 0.9863),
    nutrient(1092, '306', 'Potassium, K', 'mg', 135.5),
    nutrient(1093, '307', 'Sodium, Na', 'mg', 0),
  ],
};

/** Shelf-stable apple juice (Foundation) — energy as 2047/2048, sugars as 1063. */
export const RAW_APPLE_JUICE: RawFoodDetail = {
  fdcId: 2003590,
  description: 'Apple juice, with added vitamin C, from concentrate, shelf stable',
  dataType: 'Foundation',
  publicationDate: '10/28/2021',
  foodCategory: { description: 'Fruits and Fruit Juices' },
  foodPortions: [],
  foodNutrients: [
    nutrient(2047, '957', 'Energy (Atwater General Factors)', 'kcal', 48.3763),
    nutrient(2048, '958', 'Energy (Atwater Specific Factors)', 'kcal', 47.231814),
    nutrient(1003, '203', 'Protein', 'g', 0.0859375),
    nutrient(1004, '204', 'Total lipid (fat)', 'g', 0.2863),
    nutrient(1005, '205', 'Carbohydrate, by difference', 'g', 11.3639625),
    nutrient(1063, '269.3', 'Sugars, Total', 'g', 10.295),
    nutrient(1087, '301', 'Calcium, Ca', 'mg', 7.099),
    nutrient(1089, '303', 'Iron, Fe', 'mg', 0.04016),
    nutrient(1092, '306', 'Potassium, K', 'mg', 95.87),
    nutrient(1093, '307', 'Sodium, Na', 'mg', 4.872),
    nutrient(1162, '401', 'Vitamin C, total ascorbic acid', 'mg', 51.16),
  ],
};

/** Alaska Pollock, raw (Foundation) — energy only as the general-factor estimate 2047. */
export const RAW_POLLOCK: RawFoodDetail = {
  fdcId: 2768188,
  description: 'Alaska Pollock, raw',
  dataType: 'Foundation',
  publicationDate: '4/30/2026',
  foodCategory: { description: 'Finfish and Shellfish Products' },
  foodPortions: [],
  foodNutrients: [
    nutrient(2047, '957', 'Energy (Atwater General Factors)', 'kcal', 78.4785),
    nutrient(1003, '203', 'Protein', 'g', 17.33),
    nutrient(1004, '204', 'Total lipid (fat)', 'g', 0.9925),
    nutrient(1005, '205', 'Carbohydrate, by difference', 'g', 0.0565),
    nutrient(1079, '291', 'Fiber, total dietary', 'g', 0),
    nutrient(1087, '301', 'Calcium, Ca', 'mg', 40.36),
    nutrient(1089, '303', 'Iron, Fe', 'mg', 0.2402),
    nutrient(1092, '306', 'Potassium, K', 'mg', 353),
    nutrient(1093, '307', 'Sodium, Na', 'mg', 114.8),
    nutrient(1258, '606', 'Fatty acids, total saturated', 'g', 0.2374),
  ],
};

/** Olive oil (SR Legacy) — per 100 g, beside the per-100 ml {@link RAW_OLIVE_OIL} label. */
export const RAW_OLIVE_OIL_SR: RawFoodDetail = {
  fdcId: 171413,
  description: 'Oil, olive, salad or cooking',
  dataType: 'SR Legacy',
  publicationDate: '4/1/2019',
  foodCategory: { description: 'Fats and Oils' },
  foodPortions: [
    { amount: 1, gramWeight: 13.5, modifier: 'tablespoon', measureUnit: UNDETERMINED },
  ],
  foodNutrients: [
    nutrient(1008, '208', 'Energy', 'kcal', 884),
    nutrient(1003, '203', 'Protein', 'g', 0),
    nutrient(1004, '204', 'Total lipid (fat)', 'g', 100),
    nutrient(1005, '205', 'Carbohydrate, by difference', 'g', 0),
    nutrient(1079, '291', 'Fiber, total dietary', 'g', 0),
    nutrient(2000, '269', 'Total Sugars', 'g', 0),
    nutrient(1087, '301', 'Calcium, Ca', 'mg', 1),
    nutrient(1089, '303', 'Iron, Fe', 'mg', 0.56),
    nutrient(1092, '306', 'Potassium, K', 'mg', 1),
    nutrient(1093, '307', 'Sodium, Na', 'mg', 2),
    nutrient(1162, '401', 'Vitamin C, total ascorbic acid', 'mg', 0),
    nutrient(1258, '606', 'Fatty acids, total saturated', 'g', 13.808),
  ],
};

/** Kellogg's Frosted Flakes (Branded) — a 37 GRM label, so FDC reports it per 100 g. */
export const RAW_CEREAL: RawFoodDetail = {
  fdcId: 2642006,
  description: 'CEREAL',
  dataType: 'Branded',
  publicationDate: '9/14/2023',
  brandOwner: 'President Baking Company, Inc.',
  brandName: "KELLOGG'S FROSTED FLAKES",
  brandedFoodCategory: 'Cereal',
  gtinUpc: '041192100116',
  servingSize: 37,
  servingSizeUnit: 'GRM',
  householdServingFullText: '1 cup',
  foodPortions: [],
  foodNutrients: [
    nutrient(1008, '208', 'Energy', 'kcal', 351),
    nutrient(1005, '205', 'Carbohydrate, by difference', 'g', 89.19),
    nutrient(1079, '291', 'Fiber, total dietary', 'g', 2.7),
    nutrient(1089, '303', 'Iron, Fe', 'mg', 19.46),
    nutrient(1092, '306', 'Potassium, K', 'mg', 81),
    nutrient(2000, '269', 'Total Sugars', 'g', 32.43),
    nutrient(1004, '204', 'Total lipid (fat)', 'g', 0),
    nutrient(1093, '307', 'Sodium, Na', 'mg', 514),
    nutrient(1087, '301', 'Calcium, Ca', 'mg', 0),
    nutrient(1003, '203', 'Protein', 'g', 5.41),
    nutrient(1258, '606', 'Fatty acids, total saturated', 'g', 0),
  ],
};

/** Snap Kitchen cookie (Branded) — a 57 IU label, which fixes no per-100 basis. */
export const RAW_COOKIE: RawFoodDetail = {
  fdcId: 2538887,
  description: 'CHOCOLATE CHIP COOKIE, CHOCOLATE CHIP',
  dataType: 'Branded',
  publicationDate: '4/27/2023',
  brandOwner: 'Snap Kitchen Investments, LLC',
  brandName: 'SNAP KITCHEN',
  brandedFoodCategory: 'Cookies & Biscuits',
  gtinUpc: '812324022961',
  servingSize: 57,
  servingSizeUnit: 'IU',
  householdServingFullText: '1 cookie',
  foodPortions: [],
  foodNutrients: [
    nutrient(1093, '307', 'Sodium, Na', 'mg', 184),
    nutrient(1003, '203', 'Protein', 'g', 3.51),
    nutrient(1079, '291', 'Fiber, total dietary', 'g', 7),
    nutrient(1004, '204', 'Total lipid (fat)', 'g', 29.82),
    nutrient(1092, '306', 'Potassium, K', 'mg', 195),
    nutrient(1005, '205', 'Carbohydrate, by difference', 'g', 59.65),
    nutrient(1087, '301', 'Calcium, Ca', 'mg', 53),
    nutrient(1089, '303', 'Iron, Fe', 'mg', 3.51),
    nutrient(1008, '208', 'Energy', 'kcal', 509),
    nutrient(2000, '269', 'Total Sugars', 'g', 33.33),
    nutrient(1258, '606', 'Fatty acids, total saturated', 'g', 15.79),
  ],
};

const CATALOG = new Map<number, RawFoodDetail>(
  [
    RAW_KALE,
    RAW_SPINACH,
    RAW_CUSTARD,
    RAW_NOODLES,
    RAW_ORANGE,
    RAW_TACO,
    RAW_MILK,
    RAW_OLIVE_OIL,
    RAW_BROCCOLI,
    RAW_BROCCOLI_SR,
    RAW_FLOUR,
    RAW_APPLE_JUICE,
    RAW_POLLOCK,
    RAW_OLIVE_OIL_SR,
    RAW_CEREAL,
    RAW_COOKIE,
  ].map((food) => [food.fdcId, food]),
);

/**
 * FDC's own `nutrients` filter — it compares against `nutrient.number`, so a
 * caller sending nutrient ids matches nothing and gets an empty list back.
 */
function applyUpstreamFilter(food: RawFoodDetail, filter: readonly string[]): RawFoodDetail {
  if (filter.length === 0) return food;
  return {
    ...food,
    foodNutrients: (food.foodNutrients ?? []).filter((n) =>
      filter.includes(n.nutrient?.number ?? ''),
    ),
  };
}

function lookup(fdcId: number): RawFoodDetail {
  const food = CATALOG.get(fdcId);
  if (!food) throw new Error(`fdc-fake has no fixture for FDC ID ${fdcId}`);
  return food;
}

/** Ids the batch endpoint knows about — FDC omits the rest from its response. */
export function isKnownFdcId(fdcId: number): boolean {
  return CATALOG.has(fdcId);
}

/**
 * Builds an installed-on-demand fetch harness serving `/food/{fdcId}` and the
 * `/foods` batch endpoint. Call `install()` before exercising the service and
 * `restore()` afterwards; unmatched requests throw.
 */
export function createFdcFake(): FetchMockHarness {
  return createFetchMock([
    {
      method: 'GET',
      match: (request) => new URL(request.url).pathname.startsWith(`${BASE_PATH}/food/`),
      respond: (request) => {
        const url = new URL(request.url);
        const fdcId = Number(url.pathname.slice(`${BASE_PATH}/food/`.length));
        // The single-food endpoint is the only FDC path that 404s on a bad id.
        if (!isKnownFdcId(fdcId)) {
          return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
        }
        return Response.json(
          applyUpstreamFilter(lookup(fdcId), url.searchParams.getAll('nutrients')),
        );
      },
    },
    {
      method: 'POST',
      match: (request) => new URL(request.url).pathname === `${BASE_PATH}/foods`,
      respond: async (request) => {
        const body = (await request.json()) as { fdcIds: number[]; nutrients?: number[] };
        const filter = (body.nutrients ?? []).map(String);
        /**
         * FDC drops unknown ids from the batch response rather than erroring,
         * and answers `{}` rather than `[]` when it knows none of them.
         */
        const found = body.fdcIds.filter(isKnownFdcId);
        if (found.length === 0) return Response.json({});
        return Response.json(found.map((id) => applyUpstreamFilter(lookup(id), filter)));
      },
    },
  ]);
}
