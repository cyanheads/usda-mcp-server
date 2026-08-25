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
  name: 'usda-mcp-server',
  title: 'usda-mcp-server',
  /**
   * The listing surfaces are fixed at build time — five tools, two resources,
   * no prompts, no scope-dependent filtering — so a 2026-07-28 client can hold
   * them publicly for an hour. `resources/read` is deliberately absent: the
   * food resource proxies live FDC records, and only the bundled nutrient
   * reference is cacheable, which it declares itself.
   */
  cacheHints: {
    'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'resources/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'resources/templates/list': { ttlMs: 3_600_000, cacheScope: 'public' },
  },
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
