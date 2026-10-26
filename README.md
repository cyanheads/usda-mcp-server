<div align="center">
  <h1>@cyanheads/usda-mcp-server</h1>
  <p><b>Search foods, compare nutrients, and look up the full USDA FoodData Central database via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools • 3 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.13-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/usda-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/usda-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/usda-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/usda-mcp-server/releases/latest/download/usda-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=usda-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvdXNkYS1tY3Atc2VydmVyIl0sImVudiI6eyJVU0RBX0ZEQ19BUElfS0VZIjoieW91ci1hcGkta2V5In19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22usda-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fusda-mcp-server%22%5D%2C%22env%22%3A%7B%22USDA_FDC_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://usda.caseyjhand.com/mcp](https://usda.caseyjhand.com/mcp)

</div>

---

## Overview

Nutrition data for roughly 400,000 foods from USDA FoodData Central, the US government's authoritative food composition database. Search by keyword or UPC, pull full nutrient profiles scaled to any portion, and compare foods side by side.

### Tools

| Tool | Description |
|:---|:---|
| `usda_search_foods` | Search foods by keyword, ingredient, or UPC/GTIN across SR Legacy, Foundation, Survey (FNDDS), and Branded data sources |
| `usda_get_food` | Full nutrient profile for one food by FDC ID, with optional per-portion scaling |
| `usda_get_foods` | Batch nutrient fetch for 2–20 FDC IDs in a single request |
| `usda_compare_foods` | Side-by-side nutrient comparison for 2–5 foods, formatted as a markdown table |
| `usda_list_nutrients` | Static FDC nutrient reference table (~150 nutrients) with IDs, names, units, and categories |

### Resources

| Resource | Description |
|:---|:---|
| `usda://food/{fdcId}` | Full nutrient profile for a specific food by FDC ID |
| `usda://nutrients` | Complete FDC nutrient reference list |
| `skill://usda-guide/SKILL.md` | Food selection, serving-weight, and missing-nutrient guidance for agents |

Food profiles and the nutrient reference are also reachable via tools. Use `usda_search_foods` to discover FDC IDs before reading food resources.

## Capability reference

### `usda_search_foods` <sub>tool</sub>

- Query by keyword, ingredient name, or UPC/GTIN code; optional `dataType[]` filter across SR Legacy, Foundation, Survey (FNDDS), and Branded, defaulting to `["SR Legacy"]` (or `["Branded"]` once `brandOwner` is set)
- `brandOwner` and `foodCategory` filters narrow results; `pageSize` (max 50, default 10) and `pageNumber` paginate
- Returns FDC IDs plus available preview nutrients: protein (1003), fat (1004), carbohydrate (1005), fiber (1079), and energy (1008, 1062, 2047, 2048). Original values, units, order, and distinct energy estimates are preserved; missing entries are omitted. Use `usda_get_food` for other nutrients or the full profile
- A page past `totalPages` returns empty `foods[]`, the requested page, totals, and a notice with a valid `pageNumber` when the query has matches
- Typed errors: `query_empty` (blank query), `query_syntax` (FDC rejected the query syntax), `no_results` (nothing matched in the requested data sources)

---

### `usda_get_food` <sub>tool</sub>

- Full nutrient profile for one `fdcId`; optional `nutrients[]` filter to specific IDs
- Optional `unit` (`g` / `oz` / `lb` / `kg` / `serving`) with an optional `quantity` scales every value from the FDC per-100g basis; `quantity` defaults to 100 for mass units and 1 for `serving`. Serving uses the first valid portion, or a positive finite Branded label size in `g` / `GRM` / `GM` (case-insensitive) when no portion exists, multiplied by `quantity`
- `servingInfo` identifies the resolved portion or label serving and its gram weight; `allPortions[]` contains actual portion definitions only
- Typed errors: `not_found` (bad FDC ID), `quantity_without_unit`, `no_portion_data` (no valid portion or supported Branded gram label). Volume, IU, milligram labels, missing units, and invalid sizes require an explicit mass-unit request; no density is inferred

---

### `usda_get_foods` <sub>tool</sub>

- Batch fetch for 2–20 FDC IDs in one call; values are per-100g only (no portion scaling)
- `nutrients[]` filter strongly recommended — full profiles for 20 foods are large
- Per-ID partial failure — IDs that return no data land in `failed[]` instead of aborting the batch

---

### `usda_compare_foods` <sub>tool</sub>

- Side-by-side comparison for 2–5 FDC IDs, pivoted one row per nutrient and one column per food
- Defaults to 12 commonly compared nutrients (energy, protein, fat, saturated fat, carbs, fiber, total sugars, sodium, potassium, calcium, iron, vitamin C) unless `nutrients[]` is given
- All values scaled to a common `quantity` + `unit` basis (default 100 g; `quantity` is an amount in `unit`, so `unit: "oz"` alone compares per 100 oz)
- Proceeds with the valid foods when some IDs return no data; only throws `too_few_foods` when fewer than 2 resolve
- Rows where every food is null for that nutrient are filtered out

---

### `usda_list_nutrients` <sub>tool</sub>

- Static reference table of ~150 tracked FDC nutrients — no API call
- Optional `category` filter: `macronutrients`, `vitamins`, `minerals`, `lipids`, `amino_acids`, `other`
- Returns each nutrient's ID, name, SR reference number, unit, and category — resolve a name to the ID used by `nutrients[]` elsewhere

---

### `usda://food/{fdcId}` <sub>resource</sub>

- Same data as `usda_get_food` without portion scaling — full nutrient profile per 100g as `application/json`
- `fdcId` must be a bare positive integer (no sign, leading zero, decimal, or exponent); anything else throws `invalid_id`
- `not_found` when the ID doesn't exist in FDC

---

### `usda://nutrients` <sub>resource</sub>

- Complete FDC nutrient reference — same content as `usda_list_nutrients` with no category filter
- Served as `application/json` with a 1-hour public cache hint, since the table is bundled at build time and identical for every caller

### `skill://usda-guide/SKILL.md` <sub>resource</sub>

Guidance for matching food records, choosing a serving weight, and reporting incomplete nutrient coverage. The same [usda-guide](./skills/usda-guide/SKILL.md) ships with plugin installs, npm, Docker, and the desktop bundle.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

FoodData Central-specific:

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

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http usda-mcp-server https://usda.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add usda-mcp-server -e USDA_FDC_API_KEY=your-key -- npx -y @cyanheads/usda-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "usda-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/usda-mcp-server"],
      "env": { "USDA_FDC_API_KEY": "your-api-key" }
    }
  }
}
```

Get a free key at [api.data.gov/signup](https://api.data.gov/signup/). Food search, lookup, and comparison require it; the static nutrient reference works without it. For Docker or a source build, see [Running the server](#running-the-server).

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

Requires [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).

### Local development

```sh
git clone https://github.com/cyanheads/usda-mcp-server.git
cd usda-mcp-server && bun install
cp .env.example .env   # set USDA_FDC_API_KEY
```

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
docker run --rm -e USDA_FDC_API_KEY=your-key -p 3010:3010 ghcr.io/cyanheads/usda-mcp-server:latest
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/usda-mcp-server`. For stdio, use `docker run -i --rm -e MCP_TRANSPORT_TYPE=stdio -e USDA_FDC_API_KEY=your-key ghcr.io/cyanheads/usda-mcp-server:latest`. To build locally, run `docker build -t usda-mcp-server .`; OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools, resources, and inits `FdcService`. |
| `src/config` | Server-specific environment variable parsing and validation with Zod (`USDA_FDC_API_KEY`). |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) — search, get, batch, compare, list-nutrients. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`) — food profile and nutrient reference. |
| `src/services/fdc` | `FdcService` — USDA FDC API client, normalization, and static nutrient reference data. |
| `skills/` | Published guidance for agents calling the server. |
| `tests/` | Unit tests mirroring `src/` — every tool, resource, and the FDC service. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
