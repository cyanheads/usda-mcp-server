/**
 * @fileoverview Barrel export for all tool definitions.
 * @module mcp-server/tools/definitions/index
 */

import { usdaCompareFoods } from './usda-compare-foods.tool.js';
import { usdaGetFood } from './usda-get-food.tool.js';
import { usdaGetFoods } from './usda-get-foods.tool.js';
import { usdaListNutrients } from './usda-list-nutrients.tool.js';
import { usdaSearchFoods } from './usda-search-foods.tool.js';

export const allToolDefinitions = [
  usdaListNutrients,
  usdaSearchFoods,
  usdaGetFood,
  usdaGetFoods,
  usdaCompareFoods,
];
