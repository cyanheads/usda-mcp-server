/**
 * @fileoverview Barrel export for all resource definitions.
 * @module mcp-server/resources/definitions/index
 */

export { usdaFoodResource } from './usda-food.resource.js';
export { usdaNutrientsResource } from './usda-nutrients.resource.js';

import { usdaFoodResource } from './usda-food.resource.js';
import { usdaNutrientsResource } from './usda-nutrients.resource.js';

export const allResourceDefinitions = [usdaFoodResource, usdaNutrientsResource];
