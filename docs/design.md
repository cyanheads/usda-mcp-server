# usda-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations | Errors |
|:-----|:------------|:-----------|:------------|:-------|
| `usda_search_foods` | Search foods by name across FDC data sources | `query`, `dataType[]`, `foodCategory`, `pageSize`, `pageNumber` | `readOnlyHint: true`, `openWorldHint: true` | `no_results` (NotFound, not retryable) |
| `usda_get_food` | Full nutrient profile for a food by FDC ID, with per-portion scaling | `fdcId`, `nutrients[]`, `quantity`, `unit` | `readOnlyHint: true`, `openWorldHint: false` | `not_found` (NotFound, not retryable), `invalid_unit` (InvalidParams, not retryable), `no_portion_data` (InvalidParams, not retryable) |
| `usda_get_foods` | Fetch nutrient profiles for multiple foods at once; returns per-food nutrient data | `fdcIds[]`, `nutrients[]` | `readOnlyHint: true`, `openWorldHint: false` | per-item failures reported in `failed[]` (not thrown) |
| `usda_compare_foods` | Side-by-side nutrient comparison for 2–5 foods — formats a markdown table showing values for each requested nutrient | `fdcIds[]`, `nutrients[]`, `quantity`, `unit` | `readOnlyHint: true`, `openWorldHint: false` | `too_few_foods` (InvalidParams, not retryable — thrown only when fewer than 2 IDs return data) |
| `usda_list_nutrients` | List all tracked nutrients with their FDC IDs, names, and units — the nutrient dictionary | `category` (optional) | `readOnlyHint: true`, `openWorldHint: false` | none (static data) |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `usda://food/{fdcId}` | Nutrient profile for a specific food by FDC ID | No |
| `usda://nutrients` | Full nutrient reference list (all ~150 nutrients with IDs, names, units) | No |

### Prompts

None. The server is data-oriented; the tools are self-sufficient.

---

## Overview

usda-mcp-server exposes the USDA FoodData Central (FDC) API to LLM agents. FDC is the US government's authoritative food composition database — nutritional values for ~400K+ foods across four data sources: SR Legacy (~7,900 common whole foods with full analytical profiles), Foundation (precision research data with sample metadata), Survey/FNDDS (foods-as-consumed from NHANES dietary surveys with portion weights), and Branded (~400K packaged products with label data).

Target workflows: answering nutrition questions ("how much protein in chicken breast?"), comparing foods ("iron in spinach vs kale"), looking up packaged products by name or brand, scaling nutrient values to a given portion size, and giving agents a nutrient dictionary for ID resolution.

## Requirements

- Auth: USDA data.gov API key (required, free signup). Env var: `USDA_FDC_API_KEY`.
- Rate limit: 1,000 requests/hour per IP (note: docs say 3,600 but live API header says 1,000 for DEMO_KEY; with a real key the limit is likely higher — treat conservatively).
- All nutrient values are per 100g in the FDC database. Portion scaling is done server-side when `quantity`+`unit` are provided.
- The API has no nutrient-ranked search endpoint ("foods highest in X") — this requires fetching a search result set and sorting client-side, which is too expensive. Not included.
- SR Legacy is the correct default for common whole foods. Branded is opt-in.
- UPC/GTIN lookup: branded search accepts `query` as a UPC code — no separate endpoint.
- The batch `/foods` endpoint accepts up to 20 FDC IDs (safe limit based on API behavior; abridged format returns empty nutrients so full format is required).

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `FdcService` | USDA FoodData Central REST API (`api.nal.usda.gov/fdc/v1`) | All tools and resources |

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `USDA_FDC_API_KEY` | Yes | USDA data.gov API key. Get one at https://fdc.nal.usda.gov/api-key-signup |

---

## Domain Mapping

| Noun | FDC Operations | API Endpoints |
|:-----|:---------------|:--------------|
| Food | search, get-by-id, get-multiple | `GET /foods/search`, `GET /food/{fdcId}`, `POST /foods` |
| Nutrients | list reference data (static) | built-in from known FDC nutrient IDs |

The FDC API has 4 endpoints: `/food/{fdcId}` (single), `/foods` (batch), `/foods/list` (browse paginated), `/foods/search` (keyword search). The browse list (`/foods/list`) returns foods without nutrient values and has no keyword search — it's only useful for exhaustive iteration. Not used.

---

## Tool Detail

### `usda_search_foods`

Search foods by keyword. The agent's entry point for resolving a food name to FDC IDs for follow-up calls.

**Why:** FDC uses verbose USDA descriptions ("Chicken, broilers or fryers, breast, skinless, boneless, meat only, raw") that don't match casual input. Keyword search handles the gap. Returns basic info + a preview of key nutrients (protein, fat, carbs, energy) from the search result, so the agent can often answer simple "how much protein?" questions without a follow-up `usda_get_food` call.

**Input schema:**
- `query: string` — search terms (required). Can be a food name, UPC/GTIN code (for branded), or ingredient.
- `dataType: enum[]` optional, default `["SR Legacy"]` (or `["Branded"]` when `brandOwner` is set) — which FDC data sources to search. Options: `"SR Legacy"`, `"Foundation"`, `"Survey (FNDDS)"`, `"Branded"`. Multiple allowed. Defaults to SR Legacy because it's the most complete and least noisy for common foods.
- `brandOwner: string` optional — filter branded results by brand owner name (e.g., "General Mills"). Only Branded records carry one, so supplying it selects Branded unless `dataType` is given explicitly.
- `foodCategory: string` optional — filter by food category (e.g., "Poultry Products", "Vegetables and Vegetable Products").
- `pageSize: number` optional, default 10, max 50 — results per page.
- `pageNumber: number` optional, default 1.

**Output schema:**
- `totalHits: number`
- `currentPage: number`
- `totalPages: number`
- `foods: array` — each item:
  - `fdcId: number` — use this for `usda_get_food` / `usda_compare_foods`
  - `description: string`
  - `dataType: string`
  - `foodCategory: string` optional
  - `brandOwner: string` optional (Branded only)
  - `brandName: string` optional (Branded only)
  - `servingSize: number` optional (Branded only, grams)
  - `servingSizeUnit: string` optional
  - `householdServingFullText: string` optional
  - `nutrients: array` — up to 5 nutrients returned by the FDC search response. The set is not guaranteed or configurable at this endpoint: SR Legacy typically returns energy (1008), protein (1003), total fat (1004), carbohydrate (1005), and fiber (1079); Branded items may return fewer. Each: `{ id: number, name: string, amount: number, unit: string }`. For a complete, filterable nutrient profile, use `usda_get_food`.
  - `publishedDate: string`

**Errors:**

| reason | code | when | retryable? |
|:-------|:-----|:-----|:-----------|
| `no_results` | NotFound | No foods matched the query | No — broaden query, check spelling, try a different `dataType` |

Upstream 429/5xx bubble as `ServiceUnavailable` (retryable).

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `usda_get_food`

Full nutrient profile for one food. Returns all available nutrients (or a filtered subset) with optional per-portion scaling. The canonical "what are the nutrition facts for X?" tool.

**Why not merge with search?** The search endpoint returns a subset of nutrients for each food, not the full ~150-nutrient profile. Getting a full profile requires the single-food endpoint. Keeping them separate lets the agent do a lightweight search first, then fetch full detail only when needed.

**Input schema:**
- `fdcId: number` — FDC ID of the food (from `usda_search_foods` results).
- `nutrients: number[]` optional — filter to specific nutrient IDs (e.g., `[1003, 1004, 1005, 1008]` for macros only). Without this, all available nutrients are returned. Use to reduce context size when only specific nutrients are needed.
- `quantity: number` optional — amount of food to scale nutrients to. When provided, `unit` is required.
- `unit: enum` optional — unit for `quantity`: `"g"` | `"oz"` | `"lb"` | `"kg"` | `"serving"`. `"serving"` uses the food's first available portion weight. Required when `quantity` is provided.

**Output schema:**
- `fdcId: number`
- `description: string`
- `dataType: string`
- `foodCategory: string` optional
- `publicationDate: string`
- `brandOwner: string` optional
- `brandName: string` optional
- `ingredients: string` optional (Branded only)
- `servingInfo: object` optional — `{ description, gramWeight }` — the first available portion, if present.
- `allPortions: array` optional — `[{ description, gramWeight }]` — all named portions.
- `scaledTo: object` optional — present when `quantity`+`unit` were provided: `{ quantity, unit, gramWeight }` — what the nutrients were scaled to.
- `nutrients: array` — each item:
  - `id: number` — FDC nutrient ID (use this for filtering in other tools)
  - `name: string` — human-readable name ("Protein", "Energy", "Iron, Fe")
  - `number: string` — SR reference number (legacy, secondary)
  - `amount: number` — value per 100g, or scaled to `quantity`+`unit` if provided
  - `unit: string` — "G", "MG", "UG", "KCAL", etc.
  - `percentDailyValue: number` optional (Branded only)

**Errors:**

| reason | code | when | retryable? |
|:-------|:-----|:-----|:-----------|
| `not_found` | NotFound | FDC ID doesn't exist | No — verify ID from a search result |
| `invalid_unit` | InvalidParams | Unrecognized `unit` string | No — use `g`, `oz`, `lb`, `kg`, or `serving` |
| `no_portion_data` | InvalidParams | `unit: "serving"` requested but food has no portion data | No — use a gram-based unit instead |

Upstream 429/5xx bubble as `ServiceUnavailable` (retryable).

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

### `usda_get_foods`

Batch version of `usda_get_food` — fetches nutrient profiles for 2–20 foods in a single API call. Use when the agent already has multiple FDC IDs and needs nutrient data for all of them. More efficient than calling `usda_get_food` N times.

**Why not always use this instead of `usda_get_food`?** For a single food, the API surface is simpler. This tool is the explicit "I have multiple IDs" path and does not support per-portion scaling (the output is always per-100g), since scaling to a common basis is the expected use when comparing batch results.

**Input schema:**
- `fdcIds: number[]` — 2 to 20 FDC IDs. Use `usda_search_foods` to discover IDs.
- `nutrients: number[]` optional — filter to specific nutrient IDs. Strongly recommended to keep response size manageable.

**Output schema:**
- `foods: array` — per-food results, each:
  - `fdcId: number`
  - `description: string`
  - `dataType: string`
  - `nutrients: array` — `[{ id, name, number, amount, unit }]` — all per 100g
- `failed: array` — `[{ fdcId, error }]` — IDs that returned no data (not found, etc.)

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

### `usda_compare_foods`

Side-by-side nutrient comparison for 2–5 foods. Takes FDC IDs and returns a structured comparison table — one row per nutrient, one column per food. This is the high-value tool for "spinach vs kale iron" or "which has more protein?" questions.

**Why a dedicated tool?** `usda_get_foods` returns per-food arrays, but formatting a comparison requires pivoting the data (nutrient rows × food columns). The comparison table is far more useful for the agent's response than parallel arrays. Dedicated tool earns its keep by doing the pivot and formatting.

**Input schema:**
- `fdcIds: number[]` — 2 to 5 FDC IDs to compare.
- `nutrients: number[]` optional — which nutrients to include in the comparison. Defaults to the 12 most commonly compared: energy (1008), protein (1003), total fat (1004), saturated fat (1258), carbohydrate (1005), fiber (1079), total sugars (2000), sodium (1093), potassium (1092), calcium (1087), iron (1089), vitamin C (1162). Provide this to get different nutrients.
- `quantity: number` optional, default 100 — gram basis for comparison. All values scaled to this many grams.
- `unit: enum` optional, default `"g"` — unit for `quantity`: `"g"` | `"oz"` | `"lb"` | `"kg"`.

**Output schema:**
- `basis: object` — `{ quantity, unit, gramWeight }` — what all values are scaled to
- `foods: array` — `[{ fdcId, description, dataType }]` — the compared foods in order
- `nutrients: array` — one entry per nutrient, each:
  - `id: number`
  - `name: string`
  - `unit: string`
  - `values: array` — one number (or null) per food, in same order as `foods`
- `missingData: array` optional — foods/nutrients where data was unavailable: `[{ fdcId, nutrientId }]`

**Partial success:** If one or more FDC IDs are not found, the comparison proceeds with the IDs that returned data. A `not_found` entry is added to `missingData` for each missing ID (with `nutrientId: null`). The tool only throws `too_few_foods` when fewer than 2 IDs return data — i.e., 0 or 1 valid food. This means an agent passing 3 IDs where 1 is bad gets a valid 2-food comparison, not an error.

**format():** Renders a markdown table with food descriptions as column headers and nutrient names (with units) as row labels. Each cell shows the scaled value, or `—` when data is absent. Leads with a `**Basis:**` line (e.g., `100 g`) and appends a `**Missing data:**` note listing any `missingData` entries.

**Errors:**

| reason | code | when | retryable? |
|:-------|:-----|:-----|:-----------|
| `too_few_foods` | InvalidParams | Fewer than 2 of the provided FDC IDs returned data | No — verify IDs from search results; tool proceeds with valid IDs, only throws when fewer than 2 succeed |

Upstream 429/5xx bubble as `ServiceUnavailable` (retryable).

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

### `usda_list_nutrients`

Returns the FDC nutrient reference table — all tracked nutrients with their numeric IDs, names, and units. This is the agent's dictionary for resolving "vitamin C" → ID 1162. Call once; the data is stable (SR Legacy is a final release, Foundation/Survey nutrient IDs are consistent).

**Why not just hardcode in tool descriptions?** There are ~150 tracked nutrients. Embedding even the most common ones bloats every tool's description. A dedicated lookup tool is cleaner and avoids agents guessing IDs.

**Implementation note:** This doesn't require an API call — the nutrient list is well-known and stable. Implement as a static lookup built into the service, possibly with a category filter. Consider caching the result indefinitely via `ctx.state`.

**Input schema:**
- `category: enum` optional — filter to a nutrient category: `"macronutrients"` | `"vitamins"` | `"minerals"` | `"lipids"` | `"amino_acids"` | `"other"`. Without this, returns all nutrients.

**Output schema:**
- `nutrients: array` — each:
  - `id: number` — FDC nutrient ID (pass to `nutrients[]` param on other tools)
  - `name: string` — human-readable name
  - `number: string` — SR reference number (legacy identifier)
  - `unit: string` — measurement unit
  - `category: string` — grouping

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

## Workflow Analysis

### "How much protein is in chicken breast?"

Simple — one search + possibly one get:

| # | Tool | Purpose |
|:--|:-----|:--------|
| 1 | `usda_search_foods` (query="chicken breast raw", dataType=["SR Legacy"], pageSize=5) | Resolve name → FDC IDs; search result already includes protein value |
| — | *(If search result has protein value, answer directly from step 1)* | |
| 2 | `usda_get_food` (fdcId=171077, nutrients=[1003]) | Get just protein if search result was incomplete |

### "Compare iron in spinach vs kale"

| # | Tool | Purpose |
|:--|:-----|:--------|
| 1 | `usda_search_foods` (query="spinach raw", dataType=["SR Legacy"], pageSize=3) | Get spinach FDC ID |
| 2 | `usda_search_foods` (query="kale raw", dataType=["SR Legacy"], pageSize=3) | Get kale FDC ID |
| 3 | `usda_compare_foods` (fdcIds=[168462, 168421], nutrients=[1089]) | Side-by-side iron comparison |

Steps 1 and 2 can be parallelized.

### "Full nutrition facts for a banana"

| # | Tool | Purpose |
|:--|:-----|:--------|
| 1 | `usda_search_foods` (query="banana raw", dataType=["SR Legacy"], pageSize=3) | Find banana FDC ID |
| 2 | `usda_get_food` (fdcId=...) | Full nutrient profile, all nutrients |

### "Nutrition in 200g of brown rice"

| # | Tool | Purpose |
|:--|:-----|:--------|
| 1 | `usda_search_foods` (query="brown rice cooked", dataType=["SR Legacy"], pageSize=3) | Find rice FDC ID |
| 2 | `usda_get_food` (fdcId=..., quantity=200, unit="g") | Per-200g scaled profile |

### "Nutrition info for Cheerios" (branded lookup)

| # | Tool | Purpose |
|:--|:-----|:--------|
| 1 | `usda_search_foods` (query="Cheerios", dataType=["Branded"], brandOwner="General Mills", pageSize=5) | Find Cheerios FDC ID |
| 2 | `usda_get_food` (fdcId=2517161, nutrients=[1008, 1003, 1004, 1005]) | Macro profile, optionally scaled to serving |

### "What vitamin C is in these 4 fruits?" (agent already has IDs)

| # | Tool | Purpose |
|:--|:-----|:--------|
| 1 | `usda_list_nutrients` (category="vitamins") | Resolve "vitamin C" → ID 1162 |
| 2 | `usda_compare_foods` (fdcIds=[...], nutrients=[1162]) | Vitamin C comparison table |

---

## Design Decisions

### Nutrient resolution: dedicated `usda_list_nutrients` tool, no internal name→ID resolution

Options considered:
1. Accept human-readable names in `nutrients` param and resolve internally
2. Dedicated lookup tool; all other tools accept only numeric IDs
3. Both — numeric IDs primary, names as convenience aliases

Decision: **Option 2** (dedicated tool). Keeping IDs canonical avoids ambiguity ("vitamin E" could be tocopherol alpha alone or the family; "folate" vs "folic acid" are different FDC entries). Agents using IDs is idiomatic — they call `usda_list_nutrients` once, get the dictionary, then use IDs confidently. Internal name matching would require fuzzy logic and could silently return the wrong nutrient. The dedicated tool is explicit and auditable.

### `usda_search_foods` returns nutrient preview vs not

The FDC search endpoint returns `foodNutrients[]` alongside each result. These are a partial set (typically 5–10 nutrients), not the full profile. Including them in the search result lets the agent answer common "how much protein?" questions from the search alone without a follow-up `usda_get_food` call. They're included in the output — labeled as a preview, not a full profile — to enable this pattern while making the limitation visible.

### No `usda_search_branded` — branded search is `usda_search_foods` with `dataType: ["Branded"]`

The idea doc proposed a separate `usda_search_branded` tool. On reflection, the only behavioral difference is the default `dataType` and the `brandOwner` filter — both are parameters on the unified search tool. A separate branded tool duplicates the surface and forces agents to choose between two search tools. The `dataType` enum and `brandOwner` param handle this cleanly. The description on `usda_search_foods` calls out branded use explicitly.

### `usda_compare_foods` instead of "call `usda_get_food` twice"

"Compare X vs Y" is the most common multi-food query. The comparison pivot (nutrient rows × food columns) adds real value: it's the format agents actually want for "which has more iron?" and it eliminates an N-call fan-out. The tool also handles the common scaling question (compare both on a 100g basis) without the agent needing to do arithmetic.

Deferring `usda_compare_foods` would make every comparison query a multi-step fan-out + agent-side formatting problem. It earns its keep.

### No "foods highest in X" tool

A nutrient-ranked search ("what foods are highest in vitamin D?") would require fetching a large result set across the SR Legacy corpus and sorting by a specific nutrient ID. The FDC API doesn't support server-side nutrient-ranked sorting. Client-side implementation would mean fetching hundreds of records per query, burning rate limit budget, and producing unreliable results (only from what was searched). Cut for now. The FDC website has a component search feature for this; agents can suggest users check the USDA site.

### `usda_get_foods` vs just using `usda_compare_foods`

`usda_get_foods` returns raw per-food nutrient arrays without pivoting or formatting. `usda_compare_foods` formats the pivot table. They serve different use cases:
- Agent wants to retrieve data for N foods to reason over programmatically → `usda_get_foods`
- Agent wants to present a comparison to a user → `usda_compare_foods`

Both use the same underlying batch API call. The formatting and output schema differ.

### Portion scaling in `usda_get_food` but not `usda_get_foods`

`usda_get_food` is the "nutrition facts for this food" tool — "how many calories in 200g of chicken?" is a natural single-food query. Scaling there makes sense.

`usda_get_foods` is the "fetch raw data for these IDs" tool — it's a batch data fetch, not a nutrition question. Agents calling it are doing their own analysis. Adding scaling would complicate the schema (per-food scale params?) with little gain. For scaled comparisons, `usda_compare_foods` with `quantity`+`unit` handles it.

### Nutrient filtering happens locally, never upstream

The `nutrients[]` param on `usda_get_food`, `usda_get_foods`, and `usda_compare_foods` takes FDC nutrient **ids** — the identifiers `usda_list_nutrients` hands out. FDC's own `nutrients` query/body parameter takes SR **numbers**, so forwarding the caller's ids matched nothing and every filtered call came back empty.

The filter is therefore applied only in `normalizeFoodDetail`, against `id`. The alternative — translating id → number through the static nutrient reference table — was rejected: that table's ids are known to disagree with live FDC for some entries, which would make response completeness depend on reference data that is independently in doubt.

Cost: a filtered request now fetches the full profile upstream (~40 KB vs ~3 KB for a two-nutrient SR Legacy food). The client-facing response is unaffected — it is still narrowed to the requested ids — so `nutrients[]` remains the right advice for keeping agent context small. Measured at the 20-id ceiling of `usda_get_foods`, an unfiltered batch returns in ~2.5 s against the 15 s timeout, so the extra bytes stay well inside budget.

### The default Sugars row uses id 2000, not 1063

FDC carries total sugars under two distinct nutrients: `2000` `Total Sugars` (number `269`) and `1063` `Sugars, Total` (number `269.3`). Both are correct entries and both belong in the reference table, but they are reported by different data types — sampled across 146 foods, `1063` appeared only in Foundation records, while `2000` covered SR Legacy, Survey (FNDDS), and Branded.

`DEFAULT_COMPARE_NUTRIENTS` therefore requests `2000`. Because `usda_search_foods` defaults to SR Legacy, the documented search → compare workflow would otherwise report the Sugars row missing on every default comparison while the value sat in the payload under the other id. Callers comparing Foundation foods can still request `1063` explicitly, and a food genuinely lacking it is still reported through `missingData[]`.

### Data source defaults

`usda_search_foods` defaults to `dataType: ["SR Legacy"]` because:
- SR Legacy has complete analytical nutrient profiles (Foundation, FNDDS are similar but smaller)
- Branded is ~50× larger, noisier, and often has sparse nutrient data
- Most nutrition questions are about generic foods ("banana", "salmon", "oats"), not branded products
- Branded search burns more rate-limit budget due to hit volume

Agents that need branded can opt in explicitly. The tool description makes this choice visible.

**Exception: `brandOwner` implies Branded.** When `brandOwner` is set and `dataType` is omitted, the default flips to `["Branded"]`. Only Branded records carry a `brandOwner` field, so the SR Legacy default made that combination structurally unmatchable — a brand search would return zero hits for any brand, on any query. An explicit `dataType` always wins, including a non-Branded one; that combination still resolves through the normal `no_results` path rather than a new error.

---

## Known Limitations

- **Nutrient-ranked search not supported.** The API has no server-side sort by nutrient value. "Foods highest in X" queries aren't feasible without bulk download.
- **SR Legacy is a final release (April 2018).** Data is stable but not updated for new foods. Use Foundation or Branded for more recent data.
- **Branded nutrient data sparsity.** Not all branded products have complete nutrient profiles — many have only the label macros. `usda_get_food` on a branded item may return far fewer nutrients than an SR Legacy item.
- **Per-serving data quality varies.** Portion descriptions in SR Legacy (`"4 oz"`, `"1 package"`) are inconsistently structured — `modifier` is a free string. `"serving"` unit in `usda_get_food` uses the first available portion as a best-effort.
- **Rate limit.** 1,000 req/hour with a real API key. Multi-food comparisons across large datasets are feasible; bulk analysis loops are not.
- **No image data.** FDC is purely composition data.

---

## API Reference

**Base URL:** `https://api.nal.usda.gov/fdc/v1`

**Auth:** `?api_key=<key>` query parameter on all requests.

**Key endpoints:**

| Endpoint | Method | Purpose |
|:---------|:-------|:--------|
| `/foods/search` | GET/POST | Keyword search — returns `SearchResult` with `foods[]` |
| `/food/{fdcId}` | GET | Single food full detail |
| `/foods` | GET/POST | Batch food detail — `fdcIds[]` + optional `nutrients[]` filter |
| `/foods/list` | GET/POST | Paged browse (no search, no nutrient values) — not used |

**Search parameters:** `query`, `dataType[]`, `foodCategory`, `brandOwner`, `pageSize` (default 50), `pageNumber` (1-based), `sortBy`, `sortOrder`, `requireAllWords`.

**Batch `/foods` notes:**
- The `nutrients` filter — on `/foods` and `/food/{fdcId}` alike — matches SR **numbers** (`208`, `203`), not FDC nutrient **ids** (`1008`, `1003`). Sending ids returns an empty `foodNutrients[]`, so this server does not forward the filter (see "Nutrient filtering" under Design Decisions)
- Do NOT use `format: "abridged"` — abridged returns empty `foodNutrients[]` despite having a size advantage
- Safe batch limit: 20 FDC IDs per request

**Nutrient values:** All amounts are per 100g. Scale by `(quantity_grams / 100)` for other amounts.

**Data type strings for filtering:**
- `"SR Legacy"` — common whole foods, complete profiles
- `"Foundation"` — high-quality analytical, sample metadata
- `"Survey (FNDDS)"` — dietary survey foods with portion weights
- `"Branded"` — packaged products from label data

**Rate limits:** 1,000 req/hour per IP (DEMO_KEY: 30/hour, 50/day).

**Error envelope:**
```json
{ "error": { "code": "OVER_RATE_LIMIT", "message": "..." } }
```
HTTP 429 for rate limits.

---

## Implementation Order

1. Config (`USDA_FDC_API_KEY`) and server setup
2. `FdcService` — search, single-food GET, batch GET, retry + rate-limit handling
3. Static nutrient reference data (embedded lookup table for `usda_list_nutrients`)
4. `usda_list_nutrients` (no API call — static data)
5. `usda_search_foods`
6. `usda_get_food` with portion scaling logic
7. `usda_get_foods` (batch)
8. `usda_compare_foods` (uses batch internally, adds pivot + format)
9. Resources (`usda://food/{fdcId}`, `usda://nutrients`)
