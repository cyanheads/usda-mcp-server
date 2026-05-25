#!/usr/bin/env node
/**
 * @fileoverview usda-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allResourceDefinitions } from './mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initFdcService } from './services/fdc/fdc-service.js';

await createApp({
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: [],
  instructions:
    'USDA FoodData Central (FDC) — authoritative US food composition database (~400K+ foods).\n' +
    'Key workflow: usda_search_foods → fdcId → usda_get_food (single) or usda_compare_foods (comparison).\n' +
    'Use usda_list_nutrients to resolve nutrient names to numeric IDs before filtering.',
  setup() {
    initFdcService();
  },
});
