/**
 * @fileoverview Domain types for the USDA FoodData Central API.
 * @module services/fdc/types
 */

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
  gramWeight?: number;
  id?: number;
  measureUnit?: { name?: string };
  modifier?: string;
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
  brandName?: string;
  brandOwner?: string;
  dataType?: string;
  description: string;
  fdcId: number;
  foodCategory?: string | { description?: string };
  foodNutrients?: RawFoodNutrient[];
  foodPortions?: RawFoodPortion[];
  ingredients?: string;
  publicationDate?: string;
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
  description: string;
  gramWeight: number;
}

/** Normalized full food detail. */
export interface FoodDetail {
  brandName?: string;
  brandOwner?: string;
  dataType: string;
  description: string;
  fdcId: number;
  foodCategory?: string;
  ingredients?: string;
  nutrients: FoodNutrient[];
  portions: FoodPortion[];
  publicationDate?: string;
}

/** Normalized search result food. */
export interface SearchResultFood {
  brandName?: string;
  brandOwner?: string;
  dataType: string;
  description: string;
  fdcId: number;
  foodCategory?: string;
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
