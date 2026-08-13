<div align="center">
  <h1>@cyanheads/usda-mcp-server</h1>
  <p><b>Search foods, compare nutrients, and look up the full USDA FoodData Central database via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.7-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/usda-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.30.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/usda-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/usda-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.14-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/usda-mcp-server/releases/latest/download/usda-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=usda-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvdXNkYS1tY3Atc2VydmVyIl0sImVudiI6eyJVU0RBX0ZEQ19BUElfS0VZIjoieW91ci1hcGkta2V5In19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22usda-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fusda-mcp-server%22%5D%2C%22env%22%3A%7B%22USDA_FDC_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://usda.caseyjhand.com/mcp](https://usda.caseyjhand.com/mcp)

</div>

---

## Tools

Five tools covering the USDA FoodData Central workflow — from discovery to detailed nutrient analysis:

| Tool | Description |
|:---|:---|
| `usda_search_foods` | Search foods by keyword across SR Legacy, Foundation, Survey FNDDS, and Branded data sources, with nutrient preview and pagination |
| `usda_get_food` | Full nutrient profile for one food by FDC ID, with optional per-portion scaling (g, oz, lb, kg, or serving) |
| `usda_get_foods` | Batch nutrient fetch for 2–20 FDC IDs in a single request; failed IDs reported in `failed[]` instead of aborting |
| `usda_compare_foods` | Side-by-side nutrient comparison for 2–5 foods, formatted as a markdown table scaled to a common gram basis |
| `usda_list_nutrients` | Static FDC nutrient reference table (~150 nutrients) with IDs, names, units, and categories — no API call required |

### `usda_search_foods`

Search USDA FoodData Central foods by keyword, UPC/GTIN code, or ingredient.

- Covers all FDC data sources: SR Legacy (common whole foods, complete nutrient profiles), Foundation, Survey FNDDS, and Branded (packaged products)
- Defaults to SR Legacy; include `"Branded"` in `dataType` for packaged products or UPC lookup
- Brand owner filter to narrow branded results (e.g. `"General Mills"`) — setting `brandOwner` without `dataType` searches Branded, since only Branded records carry a brand owner
- Food category filter (e.g. `"Poultry Products"`, `"Vegetables and Vegetable Products"`)
- Pagination via `pageSize` (up to 50) and `pageNumber`
- Returns FDC IDs and a preview of key nutrients (energy, protein, fat, carbs) — use `usda_get_food` for the full profile

---

### `usda_get_food`

Full nutrient profile for one food by FDC ID.

- All available nutrients (or a filtered subset via `nutrients[]`) with amounts per 100g
- Optional portion scaling — provide `quantity` + `unit` to scale values (e.g. `quantity=200, unit="g"` → per-200g values)
- `unit="serving"` scales to the food's first defined portion weight
- Returns all named portion definitions (`allPortions[]`) alongside the serving info
- Filtering `nutrients[]` to specific IDs strongly reduces context size for common queries (use `usda_list_nutrients` to look up IDs)

---

### `usda_get_foods`

Batch nutrient fetch for 2–20 FDC IDs.

- All values per 100g (no portion scaling in batch mode)
- `nutrients[]` filter strongly recommended — full profiles for 20 foods are large
- Per-item partial failure: `failed[]` carries IDs that returned no data, so one missing food doesn't abort the batch
- More efficient than N individual `usda_get_food` calls when you already have FDC IDs

---

### `usda_compare_foods`

Side-by-side nutrient comparison for 2–5 foods.

- Returns a pivot table — one row per nutrient, one column per food — and formats it as a markdown table
- Defaults to the 12 most commonly compared nutrients (energy, protein, fat, saturated fat, carbs, fiber, total sugars, sodium, potassium, calcium, iron, vitamin C)
- Pass custom `nutrients[]` for specific comparisons (e.g. just iron and vitamin C)
- All values scaled to a common gram basis (default 100g; override with `quantity` + `unit`)
- Proceeds with valid foods when some IDs aren't found — only fails when fewer than 2 IDs return data
- Rows where all values are null (nutrient not tracked for any of the selected foods) are filtered out

---

### `usda_list_nutrients`

FDC nutrient reference table — all ~150 tracked nutrients.

- Returns IDs, names, SR reference numbers, units, and categories
- Optional `category` filter: `macronutrients`, `vitamins`, `minerals`, `lipids`, `amino_acids`, `other`
- Resolves nutrient names (e.g. `"vitamin C"`) to FDC IDs (1162) for use in `nutrients[]` params
- Static data — no API call, instant response; call once and reuse the IDs

## Resources and prompts

| Type | Name | Description |
|:---|:---|:---|
| Resource | `usda://food/{fdcId}` | Full nutrient profile for a specific food by FDC ID — same data as `usda_get_food` without portion scaling |
| Resource | `usda://nutrients` | Complete FDC nutrient reference list — all ~150 tracked nutrients with IDs, names, units, and categories |

All resource data is also reachable via tools. Use `usda_search_foods` to discover FDC IDs before reading food resources.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

USDA FDC-specific:

- Type-safe client for the USDA FoodData Central REST API (`api.nal.usda.gov/fdc/v1`)
- Normalization layer that handles inconsistent API response shapes across search, single-food, and batch endpoints
- Batch API endpoint (`/foods`) with per-food partial failure reporting
- HTML response detection (rate-limit proxy returns 200 HTML) with service-unavailable error surfacing
- Static nutrient reference dictionary — ~150 nutrients with FDC IDs, SR numbers, units, and categories; no API call required

Agent-friendly output:

- Provenance preserved — FDC data source (`dataType`) on every food result so callers know whether they're reading curated research data or label-derived branded values
- Partial failure reporting — batch tools (`usda_get_foods`, `usda_compare_foods`) return successes alongside structured `failed[]` / `missingData[]` entries rather than failing the whole request
- Cross-reference hints — FDC IDs and tool names in descriptions so agents know exactly which call to make next (search → get → compare workflow)

## Getting started

### Public Hosted Instance

A public instance is available at `https://usda.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "usda-mcp-server": {
      "type": "streamable-http",
      "url": "https://usda.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file. See [data.gov API key signup](https://api.data.gov/signup/) to generate a free API key.

```json
{
  "mcpServers": {
    "usda-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/usda-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "USDA_FDC_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "usda-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/usda-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "USDA_FDC_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "usda-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "USDA_FDC_API_KEY=your-api-key",
        "ghcr.io/cyanheads/usda-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 USDA_FDC_API_KEY=your-api-key bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.2](https://bun.sh/) or higher (or Node.js v24+).
- A free USDA FDC API key — register at [api.data.gov/signup](https://api.data.gov/signup/). Required for food search, lookup, and comparison calls; `usda_list_nutrients` and the static nutrient reference work without it.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/usda-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd usda-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set USDA_FDC_API_KEY
```

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `USDA_FDC_API_KEY` | **Required for FoodData Central-backed tools** (search, get, batch, compare) — not for startup or `usda_list_nutrients`. Get a free key at [api.data.gov](https://api.data.gov/signup/). | — |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t usda-mcp-server .
docker run --rm -e USDA_FDC_API_KEY=your-key -p 3010:3010 usda-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/usda-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools, resources, and inits `FdcService`. |
| `src/config` | Server-specific environment variable parsing and validation with Zod (`USDA_FDC_API_KEY`). |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) — search, get, batch, compare, list-nutrients. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`) — food profile and nutrient reference. |
| `src/services/fdc` | `FdcService` — USDA FDC API client, normalization, and static nutrient reference data. |
| `tests/` | Unit tests mirroring `src/` — 50 tests across all tools and resources. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
