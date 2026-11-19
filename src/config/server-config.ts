/**
 * @fileoverview Server-specific environment variable configuration for usda-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  fdcApiKey: z.string().describe('USDA FoodData Central API key (data.gov)'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    fdcApiKey: 'USDA_FDC_API_KEY',
  });
  return _config;
}

/** Parsed apart from {@link ServerConfigSchema}, so input validation reads it without the API key. */
const LimitsConfigSchema = z.object({
  clampLimits: z
    .stringbool()
    .default(true)
    .describe(
      'Serve an over-limit request up to its cap and say what was left out: the first 20 distinct usda_get_foods IDs and the first 5 distinct usda_compare_foods IDs (the rest deferred), and a usda_search_foods pageSize of 200. false rejects more than 20 usda_get_foods entries, more than 5 usda_compare_foods entries, or a pageSize above 200',
    ),
});

export type LimitsConfig = z.infer<typeof LimitsConfigSchema>;

let _limits: LimitsConfig | undefined;

/** @throws `ConfigurationError` naming `USDA_CLAMP_LIMITS` when it is not a boolean string. */
export function getLimitsConfig(): LimitsConfig {
  _limits ??= parseEnvConfig(LimitsConfigSchema, {
    clampLimits: 'USDA_CLAMP_LIMITS',
  });
  return _limits;
}
