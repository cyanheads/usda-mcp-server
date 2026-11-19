/**
 * @fileoverview Domain types for the USDA FoodData Central API.
 * @module services/fdc/types
 */

import type { BasisUnit } from './basis.js';

/** FDC data source category strings. */
export type FdcDataType = 'SR Legacy' | 'Foundation' | 'Survey (FNDDS)' | 'Branded';

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
  /** Samples behind the value (detail and batch); SR Legacy sends 0 for calculated and assumed values. */
  dataPoints?: number;
  /** How FDC derived the value (detail and batch; search rows flatten it). */
  foodNutrientDerivation?: {
    code?: string;
    description?: string;
    /** The source category the derivation belongs to. */
    foodNutrientSource?: { code?: string; description?: string };
  };
  /** Highest sample value, in the nutrient's unit per 100 of the basis. */
  max?: number;
  /** Median sample value, in the nutrient's unit per 100 of the basis. */
  median?: number;
  /** Lowest sample value, in the nutrient's unit per 100 of the basis. */
  min?: number;
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

/**
 * What FDC records about how one nutrient value was obtained, each key present
 * only when FDC sends it. Attached to a {@link FoodNutrient} only on request.
 */
export interface NutrientProvenance {
  /** Samples behind the value, as sent (SR Legacy's 0 included); a count, never scaled. */
  dataPoints?: number;
  derivation?: {
    code: string;
    description: string;
    /** FDC's source category for the derivation (`foodNutrientSource.description`). */
    source?: string;
  };
  /** In the unit and basis of the nutrient's amount. */
  max?: number;
  /** In the unit and basis of the nutrient's amount. */
  median?: number;
  /** In the unit and basis of the nutrient's amount. */
  min?: number;
}

/** A single nutrient in a normalized food result. */
export interface FoodNutrient extends NutrientProvenance {
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
