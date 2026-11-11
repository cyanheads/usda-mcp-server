/**
 * @fileoverview Domain types for the USDA FoodData Central API.
 * @module services/fdc/types
 */

import type { BasisUnit } from './basis.js';

/** FDC data source category strings. */
export type FdcDataType = 'SR Legacy' | 'Foundation' | 'Survey (FNDDS)' | 'Branded';

/** Unit options for portion scaling. */
export type ScaleUnit = 'g' | 'oz' | 'lb' | 'kg' | 'serving';

/** Unit options for comparison basis (no "serving" — must be gram-based). */
export type CompareUnit = 'g' | 'oz' | 'lb' | 'kg';

/** Nutrient category filter for usda_list_nutrients. */
export type NutrientCategory =
  | 'macronutrients'
  | 'vitamins'
  | 'minerals'
  | 'lipids'
  | 'amino_acids'
  | 'other';

/** A nutrient in the reference dictionary. */
export interface NutrientReference {
  category: NutrientCategory;
  id: number;
  name: string;
  number: string;
  unit: string;
}

// ---- Raw FDC API shapes ----

/** Nutrient entry in a search result or batch response. */
export interface RawFoodNutrient {
  amount?: number;
  /** Nested nutrient object (returned from full food detail). */
  nutrient?: {
    id?: number;
    name?: string;
    number?: string;
    unitName?: string;
  };
  nutrientId?: number;
  nutrientName?: string;
  nutrientNumber?: string;
  percentDailyValue?: number;
  unitName?: string;
  value?: number;
}

/** Food portion from a full food detail response. */
export interface RawFoodPortion {
  /** How many of the measure unit (or the modifier's unit) `gramWeight` covers; FNDDS omits it. */
  amount?: number;
  gramWeight?: number;
  id?: number;
  /** SR Legacy and FNDDS send the placeholder `undetermined` (id 9999). */
  measureUnit?: { abbreviation?: string; id?: number; name?: string };
  /** Free text on SR Legacy and Foundation; an all-digit food code on FNDDS. */
  modifier?: string;
  /** FNDDS only, amount included (`1 small/regular`). */
  portionDescription?: string;
  sequenceNumber?: number;
}

/** A food item in search results. */
export interface RawSearchFood {
  brandName?: string;
  brandOwner?: string;
  dataType?: string;
  description: string;
  fdcId: number;
  foodCategory?: string;
  foodNutrients?: RawFoodNutrient[];
  /** Branded only, leading zeros kept (`02114029705`). */
  gtinUpc?: string;
  householdServingFullText?: string;
  publishedDate?: string;
  score?: number;
  servingSize?: number;
  servingSizeUnit?: string;
}

/** Full search response envelope from /foods/search. */
export interface RawSearchResponse {
  currentPage?: number;
  foods?: RawSearchFood[];
  pageList?: number[];
  totalHits?: number;
  totalPages?: number;
}

/** Full food detail from /food/{fdcId}. */
export interface RawFoodDetail {
  /** The category of a Branded record, which omits `foodCategory`. */
  brandedFoodCategory?: string;
  brandName?: string;
  brandOwner?: string;
  dataType?: string;
  description: string;
  fdcId: number;
  /** SR Legacy and Foundation only. */
  foodCategory?: string | { description?: string };
  foodNutrients?: RawFoodNutrient[];
  foodPortions?: RawFoodPortion[];
  /** Branded only, leading zeros kept (`02114029705`). */
  gtinUpc?: string;
  householdServingFullText?: string;
  ingredients?: string;
  publicationDate?: string;
  servingSize?: number;
  servingSizeUnit?: string;
  /** The category of a Survey (FNDDS) record, which omits `foodCategory`. */
  wweiaFoodCategory?: { wweiaFoodCategoryCode?: number; wweiaFoodCategoryDescription?: string };
}

// ---- Normalized domain types ----

/** A single nutrient in a normalized food result. */
export interface FoodNutrient {
  amount: number;
  id: number;
  name: string;
  number: string;
  percentDailyValue?: number;
  unit: string;
}

/** A portion descriptor. */
export interface FoodPortion {
  /** How many of the described unit `gramWeight` covers (`0.5` cup), when FDC sends a positive amount. */
  amount?: number;
  description: string;
  gramWeight: number;
}

/** Normalized full food detail. */
export interface FoodDetail {
  /** What the per-100 values are per; absent when a Branded label unit fixes neither. */
  basisUnit?: BasisUnit;
  brandName?: string;
  brandOwner?: string;
  dataType: string;
  description: string;
  fdcId: number;
  foodCategory?: string;
  /** Branded only, as FDC stores it. */
  gtinUpc?: string;
  householdServingFullText?: string;
  ingredients?: string;
  /** Requested nutrient IDs this food's profile does not report, in request order; absent when none or unfiltered. */
  missingNutrients?: number[];
  nutrients: FoodNutrient[];
  portions: FoodPortion[];
  publicationDate?: string;
  servingSize?: number;
  servingSizeUnit?: string;
}

/** Normalized search result food. */
export interface SearchResultFood {
  /** What the per-100 values are per; absent when a Branded label unit fixes neither. */
  basisUnit?: BasisUnit;
  brandName?: string;
  brandOwner?: string;
  dataType: string;
  description: string;
  fdcId: number;
  foodCategory?: string;
  /** Branded only, as FDC stores it. */
  gtinUpc?: string;
  householdServingFullText?: string;
  nutrients: Array<{
    id: number;
    name: string;
    amount: number;
    unit: string;
  }>;
  publishedDate?: string;
  servingSize?: number;
  servingSizeUnit?: string;
}
