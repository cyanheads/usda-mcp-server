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
