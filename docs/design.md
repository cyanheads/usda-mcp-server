# usda-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations | Errors |
|:-----|:------------|:-----------|:------------|:-------|
| `usda_search_foods` | Search foods by name across FDC data sources | `query`, `requireAllWords`, `dataType[]`, `brandOwner`, `foodCategory`, `pageSize`, `pageNumber` | `readOnlyHint: true`, `openWorldHint: true` | `query_empty` (ValidationError, not retryable), `query_syntax` (ValidationError, not retryable), `no_results` (NotFound, not retryable), `result_window_exceeded` (ValidationError, not retryable), `retry_deadline_exceeded` (Timeout, retryable) |
| `usda_get_food` | Full nutrient profile for a food by FDC ID, with per-portion scaling | `fdcId`, `nutrients[]`, `quantity`, `unit` | `readOnlyHint: true`, `openWorldHint: false` | `not_found` (NotFound, not retryable), `quantity_without_unit` (ValidationError, not retryable), `no_portion_data` (NotFound, not retryable), `retry_deadline_exceeded` (Timeout, retryable) |
| `usda_get_foods` | Fetch nutrient profiles for multiple foods at once; returns per-food nutrient data | `fdcIds[]` (2–500 entries), `nutrients[]` | `readOnlyHint: true`, `openWorldHint: false` | per-item failures reported in `failed[]` (not thrown); `retry_deadline_exceeded` (Timeout, retryable) |
| `usda_compare_foods` | Side-by-side nutrient comparison for 2–5 foods — formats a markdown table showing values for each requested nutrient | `fdcIds[]`, `nutrients[]`, `quantity`, `unit` | `readOnlyHint: true`, `openWorldHint: false` | `too_few_foods` (ValidationError, not retryable — thrown only when fewer than 2 IDs return data), `retry_deadline_exceeded` (Timeout, retryable) |
| `usda_list_nutrients` | List all tracked nutrients with their FDC IDs, names, and units — the nutrient dictionary | `category` (optional) | `readOnlyHint: true`, `openWorldHint: false` | none (static data) |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `usda://food/{fdcId}` | Nutrient profile for a specific food by FDC ID | No |
| `usda://nutrients` | Full nutrient reference list (all ~150 nutrients with IDs, names, units) | No |
| `skill://usda-guide/SKILL.md` | Agent guidance for food selection, serving basis, and missing nutrient coverage | No |

The published `skills/usda-guide/SKILL.md` is served through `createApp({ skills: 'skills' })`; the skills extension also advertises `skill://{+path}` for file reads. Its guidance handles decisions across calls rather than restating tool schemas.

### Prompts

None. The server is data-oriented; the tools are self-sufficient.

---

## Overview

usda-mcp-server exposes the USDA FoodData Central (FDC) API to LLM agents. FDC is the US government's authoritative food composition database — nutritional values for ~400K+ foods across four data sources: SR Legacy (~7,900 common whole foods with full analytical profiles), Foundation (precision research data with sample metadata), Survey/FNDDS (foods-as-consumed from NHANES dietary surveys with portion weights), and Branded (~400K packaged products with label data).

Target workflows: answering nutrition questions ("how much protein in chicken breast?"), comparing foods ("iron in spinach vs kale"), looking up packaged products by name or brand, scaling nutrient values to a given portion size, and giving agents a nutrient dictionary for ID resolution.

## Requirements

- Auth: USDA data.gov API key (required, free signup). Env var: `USDA_FDC_API_KEY`.
- Rate limit: 1,000 requests/hour per IP (note: docs say 3,600 but live API header says 1,000 for DEMO_KEY; with a real key the limit is likely higher — treat conservatively).
- FDC reports every non-Branded food per 100 g and converts Branded label data to a 100-unit basis by the label's serving unit, so nutrient values are per 100 of `basisUnit` (see "Per-100 basis follows the label unit"). Portion scaling is done server-side when `unit` is provided; `quantity` defaults to 100 for `g`/`oz`/`lb`/`kg` and 1 for `serving`.
- The API has no nutrient-ranked search endpoint ("foods highest in X") — this requires fetching a search result set and sorting client-side, which is too expensive. Not included.
- SR Legacy is the correct default for common whole foods. Branded is opt-in.
- UPC/GTIN lookup: search accepts `query` as a UPC/GTIN code — no separate endpoint. FDC matches the stored `gtinUpc` string exactly and stores one GTIN in several digit forms, so a 12–14-digit code with a valid check digit is expanded to those forms in one OR query (see "UPC/GTIN lookup recovers the stored forms"); every other code goes as given.
- `/foods/search` serves only the first 100,000 results of a search (`FDC_RESULT_WINDOW`); it answers HTTP 400 to any page whose `pageSize × pageNumber` exceeds that.
- The batch `/foods` endpoint is called with at most 20 distinct FDC IDs per request: FDC accepts more, but large batches of full profiles approach the 15 s batch attempt and produce very large responses. An attempt that times out is refetched one ID per request (see "A timed-out batch splits per ID"). The full format is required, because the abridged format keys nutrients by SR number with no nutrient id and omits portions.

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `FdcService` | USDA FoodData Central REST API (`api.nal.usda.gov/fdc/v1`) | All tools and resources |

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `USDA_FDC_API_KEY` | Yes | USDA data.gov API key. Get one at https://fdc.nal.usda.gov/api-key-signup |
| `USDA_CLAMP_LIMITS` | No | Boolean string, default `true`. `true`: `usda_get_foods` fetches the first 20 distinct IDs of a larger request and returns the rest as `deferredIds`. `false`: it rejects more than 20 entries. An empty value reads as unset (`true`); a value that is not a boolean string fails startup. |

---

## Domain Mapping

| Noun | FDC Operations | API Endpoints |
|:-----|:---------------|:--------------|
| Food | search, get-by-id, get-multiple | `POST /foods/search`, `GET /food/{fdcId}`, `POST /foods` |
| Nutrients | list reference data (static) | built-in from known FDC nutrient IDs |

The FDC API has 4 endpoints: `/food/{fdcId}` (single), `/foods` (batch), `/foods/list` (browse paginated), `/foods/search` (keyword search). The browse list (`/foods/list`) returns foods without nutrient values and has no keyword search — it's only useful for exhaustive iteration. Not used.

---

## Tool Detail

### `usda_search_foods`

Search foods by keyword. The agent's entry point for resolving a food name to FDC IDs for follow-up calls.

**Why:** FDC uses verbose USDA descriptions ("Chicken, broilers or fryers, breast, skinless, boneless, meat only, raw") that don't match casual input. Keyword search handles the gap. Returns basic info + a preview of key nutrients (protein, fat, carbohydrate, fiber, energy) from the search result, so the agent can often answer simple "how much protein?" questions without a follow-up `usda_get_food` call.

**Input schema:**
- `query: string` — search terms (required). Can be a food name, UPC/GTIN code (for branded), or ingredient. FDC parses it as Lucene query syntax; before sending, the service backslash-escapes each `/`, `[`, `]`, `{`, `}` outside a well-formed regex or range term, every `"` when the unescaped count is odd, and each `(` or `)` without a partner, so pasted descriptions such as `trimmed to 1/8" fat` and `w/o salt` search literally. A regex term is `/…/` starting a term (after the start, whitespace, `(`, `+`, `-`, `!`, or `field:`), ending one (before the end, whitespace, `)`, `^`, or `~`), with no unescaped whitespace or `/` inside; a range term is `[low TO high]` (either side `{`/`}`, either bound `*`) in the same positions with whitespace-free bounds. Both pass through, as do phrases (their contents untouched), `+`/`-`, `AND`/`OR`/`NOT`, `*`/`?`, `~`, `^`, balanced parentheses, and `field:value`. A food matching any one unqualified word counts unless `requireAllWords` is set. A bare 12-, 13-, or 14-digit query with a valid GTIN check digit is first expanded to an OR of that GTIN's stored forms and goes out unescaped; the expansion is never shown to the caller.
- `requireAllWords: boolean` optional, default `false` — sends FDC's `requireAllWords` flag so only foods containing every query word match. Explicit `OR` and quoted phrases keep their meaning. Not sent when false.
- `dataType: enum[]` optional — which FDC data sources to search. Options: `"SR Legacy"`, `"Foundation"`, `"Survey (FNDDS)"`, `"Branded"`. Multiple allowed. Omitted, it defaults per "Data source defaults" below; an explicit value always wins.
- `brandOwner: string` optional — filter branded results by brand owner name (e.g., "General Mills"). Matched as one phrase, ignoring case and punctuation; a value containing `*` or `?` is sent as wildcard terms, each word matched on its own. Only Branded records carry one, so supplying it selects Branded unless `dataType` is given explicitly.
- `foodCategory: string` optional — filter by food category (e.g., "Poultry Products", "Vegetables and Vegetable Products"). Matched like `brandOwner`, on every data type. A whole word followed by `*` can match nothing (`Poultry*` does, where `Poult*` matches Poultry Products), so a wildcard value should be shortened.
- `pageSize: number` optional, default 10, max 50 — results per page.
- `pageNumber: number` optional, default 1.

Both filters go through `encodeFdcFilter`: FDC parses each as a Lucene query that ORs its words, so a plain value is sent as one quoted phrase (`\` and `"` escaped), and a wildcard value is sent as written because a phrase cannot carry it. Other operators (`+cereal +brandOwner:Kellog*`, `chicken -foodCategory:"Fast Foods"`) go through `query` field syntax.

**Output schema:**
- `totalHits: number`
- `currentPage: number` — requested page for an exhausted page, even when FDC resets its page to 1
- `totalPages: number` — as FDC counts them; pages past `100,000 / pageSize` (rounded down) are out of reach when `totalHits` exceeds 100,000
- `foods: array` — each item:
  - `fdcId: number` — use this for `usda_get_food` / `usda_compare_foods`
  - `description: string`
  - `dataType: string`
  - `basisUnit: 'g' | 'ml'` optional — what `nutrients[].amount` is per 100 of; absent when a Branded label unit fixes neither (amounts then per 100 label units, basis unverified)
  - `foodCategory: string` optional
  - `brandOwner: string` optional (Branded only)
  - `brandName: string` optional (Branded only)
  - `gtinUpc: string` optional (Branded only) — as FDC stores it, leading zeros kept; a query of exactly these digits finds the product again. After a 12–14-digit query it can differ from the query in leading zeros or a missing check digit
  - `servingSize: number` optional (Branded only, in `servingSizeUnit`)
  - `servingSizeUnit: string` optional (Branded only) — as FDC reports it (`GRM`, `MLT`, `IU`); it sets `basisUnit`
  - `householdServingFullText: string` optional
  - `nutrients: array` — available entries from protein (1003), fat (1004), carbohydrate (1005), fiber (1079), and energy (1008, 1062, 2047, 2048), projected locally in source order. Original IDs, names, amounts (including zero), and units are preserved; missing entries are omitted. Each: `{ id: number, name: string, amount: number, unit: string }`, with `amount` per 100 g, per 100 ml when `basisUnit` is `ml`, or per 100 label units when it is absent. For other nutrients or a complete, filterable profile, use `usda_get_food`.
  - `publishedDate: string`

**Pagination:** When `totalHits > 0` and an empty requested page exceeds `totalPages`, return empty success with totals and the requested `currentPage`. Declare `notice` enrichment and emit it through `ctx.enrich.notice` so both surfaces name the requested page, valid range, and a valid `pageNumber`. Genuine zero-match queries retain `no_results` and query-broadening recovery.

**Result window:** FDC serves only the first 100,000 results. A page whose `pageSize × pageNumber` exceeds that fails with `result_window_exceeded` (data: `query`, `pageSize`, `pageNumber`, `totalHits`, `lastReachablePage`) unless it is also past the last page, which keeps the empty-success path above. Because FDC answers HTTP 400 to such a page, the handler fetches page 1 at the same `pageSize` instead and decides from its totals whether the requested page is past the end or out of reach. When `totalHits` exceeds 100,000 the `notice` also names the last reachable page.

**Errors:**

| reason | code | when | retryable? |
|:-------|:-----|:-----|:-----------|
| `query_empty` | ValidationError | The query is empty or whitespace-only | No — provide a food name, ingredient, or UPC/GTIN code |
| `query_syntax` | ValidationError | FDC rejected the query syntax (HTTP 400), e.g. a dangling operator or trailing backslash | No — remove a leading/trailing operator or trailing backslash, or backslash-escape a literal character |
| `no_results` | NotFound | No foods matched the query | No — broaden query, check spelling, try a different `dataType`; under `requireAllWords`, retry without it; for a bare 8–14-digit query the hint instead points to a product-name search with `dataType: ["Branded"]`, and the message names the caller's query, never the barcode expansion; with `brandOwner` or `foodCategory` sent, the message names the filter; the hint says to check a phrase filter against an unfiltered search, or to shorten a wildcard filter, or to drop it |
| `result_window_exceeded` | ValidationError | `pageSize × pageNumber` exceeds the first 100,000 results FDC serves, on a page that holds matches | No — request a page at or below `lastReachablePage`, or narrow the query or filters |
| `retry_deadline_exceeded` | Timeout | FDC did not answer within the call's 45 s budget, across every attempt | Yes — retry once |

Upstream 429 bubbles as `RateLimited` and 5xx as `ServiceUnavailable` (both retryable). Each call retries within one 45 s budget (15 s per attempt, up to 3 retries); a stalled upstream fails at the budget as `Timeout` with `reason: retry_deadline_exceeded`, or as that 429's `RateLimited` error when the last attempt to complete before the cut-off was a 429.

**Annotations:** `readOnlyHint: true`, `openWorldHint: true`

---

### `usda_get_food`

Full nutrient profile for one food. Returns all available nutrients (or a filtered subset) with optional per-portion scaling. The canonical "what are the nutrition facts for X?" tool.

**Why not merge with search?** Search projects a fixed nutrient preview for each food. Keeping detail separate lets the agent do a lightweight search first, then fetch the full profile or other selected nutrients only when needed.

**Input schema:**
- `fdcId: number` — FDC ID of the food (from `usda_search_foods` results).
- `nutrients: number[]` optional — filter to specific nutrient IDs (e.g., `[1003, 1004, 1005, 1008]` for macros only). Without this, all available nutrients are returned. Use to reduce context size when only specific nutrients are needed. Requested IDs the food does not report come back in `missingNutrients`.
- `quantity: number` optional — amount of food, in `unit`, to scale nutrients to. Requires `unit`. Defaults to 100 when `unit` is `g`/`oz`/`lb`/`kg`, and to 1 when `unit` is `"serving"`.
- `unit: enum` optional — unit for `quantity`: `"g"` | `"oz"` | `"lb"` | `"kg"` | `"serving"`. Serving uses the valid portion FDC displays first (lowest `sequenceNumber`), or a positive finite Branded label size in `g`/`GRM`/`GM` (case-insensitive) when no portion exists, multiplied by `quantity`. Required when `quantity` is provided; given alone, scales to 100 of a mass unit or 1 serving.

**Output schema:**
- `fdcId: number`
- `description: string`
- `dataType: string`
- `basisUnit: 'g' | 'ml'` optional — what the per-100 values are per: `g` for every non-Branded food and for Branded labels in `g`/`GRM`/`GM`, `ml` for labels in `ml`/`MLT`; absent when the label unit fixes neither (basis unverified)
- `foodCategory: string` optional — the food category for SR Legacy and Foundation, the label category for Branded, the WWEIA category for Survey (FNDDS); absent when FDC reports none
- `publicationDate: string`
- `brandOwner: string` optional
- `brandName: string` optional
- `gtinUpc: string` optional (Branded only) — as FDC stores it, leading zeros kept
- `ingredients: string` optional (Branded only)
- `servingSize: number`, `servingSizeUnit: string`, `householdServingFullText: string` optional (Branded only) — the label serving as FDC reports it; `servingSizeUnit` sets `basisUnit`
- `servingInfo: object` optional — `{ description, gramWeight, amount? }` — the first of `allPortions` (the portion FDC displays first) or supported Branded label serving. Label descriptions identify provenance, original size/unit, and household text when available.
- `allPortions: array` optional — `[{ description, gramWeight, amount? }]` — actual named portions only, in FDC's display order (ascending `sequenceNumber`, ties as FDC lists them, unnumbered portions last); label fallback never creates an entry. `amount` is how many of the described unit `gramWeight` covers, absent for Survey (FNDDS) portions, whose description carries the amount.
- `scaledTo: object` optional — present when `unit` was provided: `{ quantity, unit, gramWeight }` — what the nutrients were scaled to; `quantity` is the requested value or its default, `gramWeight` is rounded to 4 decimals. With `basisUnit` `ml` it is applied as millilitres, and with no `basisUnit` as label units, without conversion.
- `nutrients: array` — each item:
  - `id: number` — FDC nutrient ID (use this for filtering in other tools)
  - `name: string` — human-readable name ("Protein", "Energy", "Iron, Fe")
  - `number: string` — SR reference number (legacy, secondary)
  - `amount: number` — value per 100 of `basisUnit`, or per `scaledTo.gramWeight` when `unit` is provided
  - `unit: string` — "G", "MG", "UG", "KCAL", etc.
  - `percentDailyValue: number` optional (Branded only)
- `missingNutrients: number[]` optional — requested nutrient IDs the profile does not report, deduplicated, in request order; absent when `nutrients[]` was omitted or every requested ID is present

**Notice:** Scaling a food whose `basisUnit` is not `g` carries a `notice` stating that the resolved amount was applied to its per-100 ml or label-unit basis without density conversion. `format()` renders the basis on a `**Basis:**` line (`per 100g`, `per 100 ml`, or `per 100 {unit} label units (basis unverified)`; scaled, the resolved amount in the same unit), the label serving on a `**Label serving:**` line, and `missingNutrients` on a `**Missing nutrients:**` line.

**Errors:**

| reason | code | when | retryable? |
|:-------|:-----|:-----|:-----------|
| `not_found` | NotFound | FDC ID doesn't exist | No — verify ID from a search result |
| `quantity_without_unit` | ValidationError | `quantity` provided without `unit` | No — provide `unit` (`g`, `oz`, `lb`, `kg`, or `serving`) alongside `quantity` |
| `no_portion_data` | NotFound | `unit: "serving"` requested but no valid portion or supported Branded gram label exists | No — recovery names available label size/unit and, by `basisUnit`, recommends an explicit mass-unit request or states what the values are per |
| `retry_deadline_exceeded` | Timeout | FDC did not answer within the call's 45 s budget, across every attempt | Yes — retry once |

Upstream 429 bubbles as `RateLimited` and 5xx as `ServiceUnavailable` (both retryable). One food is one record request: it is not cut at 15 s but runs to the call's 45 s deadline, and fast transient failures (5xx, 429, network) retry up to 3 times inside it. A stalled upstream fails at the deadline as `Timeout` with `reason: retry_deadline_exceeded`, or as that 429's `RateLimited` error when the last attempt to complete before the cut-off was a 429. A complete 200 body that is not JSON is `ServiceUnavailable` and is not retried.

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

### `usda_get_foods`

Batch version of `usda_get_food` — fetches nutrient profiles for up to 20 distinct foods, normally as one `/foods` request. Use when the agent already has multiple FDC IDs and needs nutrient data for all of them. More efficient than calling `usda_get_food` N times.

**Why not always use this instead of `usda_get_food`?** For a single food, the API surface is simpler. This tool is the explicit "I have multiple IDs" path and does not support per-portion scaling (values are always per 100 of each food's `basisUnit`), since scaling to a common basis is the expected use when comparing batch results.

**Input schema:**
- `fdcIds: number[]` — 2 to 500 entries (`tools/list` advertises `maxItems: 500` whatever `USDA_CLAMP_LIMITS` is). Repeats are dropped, keeping the first occurrence; the first 20 distinct IDs are fetched in one `/foods` request (one per ID if that request times out) and the rest go to `deferredIds`. With `USDA_CLAMP_LIMITS=false`, more than 20 entries fails validation as `invalid_arguments`. Use `usda_search_foods` to discover IDs.
- `nutrients: number[]` optional — filter to specific nutrient IDs. Strongly recommended to keep response size manageable.

**Output schema:**
- `foods: array` — per-food results, each:
  - `fdcId: number`
  - `description: string`
  - `dataType: string`
  - `basisUnit: 'g' | 'ml'` optional — what the per-100 values are per; absent when a Branded label unit fixes neither (basis unverified)
  - `servingSizeUnit: string` optional (Branded only) — the label unit as FDC reports it; it sets `basisUnit`
  - `nutrients: array` — `[{ id, name, number, amount, unit }]` — all per 100 of `basisUnit`
  - `missingNutrients: number[]` optional — requested nutrient IDs the food does not report, deduplicated, in request order; absent when `nutrients[]` was omitted or none are missing
- `failed: array` — `[{ fdcId, error }]` — fetched IDs that returned no data (not found, etc.); never carries `missingNutrients`. When every fetched ID is unknown, `foods` is empty and `failed` holds them all.
- `deferredIds: number[]` optional — distinct requested IDs this call did not fetch, in request order: fetched IDs FDC did not return before the call's deadline or kept failing on transiently, then those past the first 20, which were never requested; `foods` and `failed` cover neither. Absent when every distinct ID was fetched.

**Deferral:** When IDs are deferred, a `notice` names them and the follow-up: how many of the distinct IDs were fetched, which fetched IDs went unanswered, and another `usda_get_foods` call with the IDs in `deferredIds` (for unanswered IDs, optionally one at a time with `usda_get_food`), or, when exactly one remains (the tool takes at least 2), `usda_get_food` with that `fdcId`. A one-record request runs to the deadline, so `usda_get_food` can answer an ID the batch could not. The `usda.batch.deferrals` counter and a logged notice record only the IDs past the first 20.

**Errors:**

| reason | code | when | retryable? |
|:-------|:-----|:-----|:-----------|
| `retry_deadline_exceeded` | Timeout | FDC answered none of the fetched IDs within the call's 45 s budget | Yes — retry once; if it fails again, request fewer foods per call or fetch them one at a time with `usda_get_food` |

Fast transient failures (5xx, 429, network) retry the batch request up to 3 times inside the call's 45 s budget. A batch attempt that times out at 15 s is not retried whole; see "A timed-out batch splits per ID". The deadline error names the request (`FDC /foods request exceeded its 45000ms retry deadline after N attempts.`). A non-transient refetch failure (another 4xx) fails the call. `format()` renders a `**Nutrients ({basis label}):**` list per food, a `**Label unit:**` field on the header when the food has one, a `**Missing nutrients:**` line, a `### Failed IDs` list, and a `**Deferred (not fetched):**` line.

**Annotations:** `readOnlyHint: true`, `openWorldHint: false`

---

### `usda_compare_foods`

Side-by-side nutrient comparison for 2–5 foods. Takes FDC IDs and returns a structured comparison table — one row per nutrient, one column per food. This is the high-value tool for "spinach vs kale iron" or "which has more protein?" questions.

**Why a dedicated tool?** `usda_get_foods` returns per-food arrays, but formatting a comparison requires pivoting the data (nutrient rows × food columns). The comparison table is far more useful for the agent's response than parallel arrays. Dedicated tool earns its keep by doing the pivot and formatting.

**Input schema:**
- `fdcIds: number[]` — 2 to 5 FDC IDs to compare.
- `nutrients: number[]` optional — which nutrients to include in the comparison. Defaults to the 12 most commonly compared: energy (1008), protein (1003), total fat (1004), saturated fat (1258), carbohydrate (1005), fiber (1079), total sugars (2000), sodium (1093), potassium (1092), calcium (1087), iron (1089), vitamin C (1162). Under these defaults, a food that does not report energy (1008) has that cell filled from 2048, then 2047, and one that does not report total sugars (2000) has it filled from 1063; fills are listed in `substitutions`. Provide this to get different nutrients; an explicit list is compared as given, without fills.
- `quantity: number` optional, default 100 — amount of food, in `unit`, that every value is scaled to (`unit: "oz"` alone compares per 100 oz).
- `unit: enum` optional, default `"g"` — unit for `quantity`: `"g"` | `"oz"` | `"lb"` | `"kg"`.

**Output schema:**
- `basis: object` — `{ quantity, unit, gramWeight }` — what all values are scaled to. Every column is per `gramWeight` grams, except that a food with `basisUnit` `ml` is per that many millilitres and one with no `basisUnit` per that many label units, compared without conversion.
- `foods: array` — `[{ fdcId, description, dataType, basisUnit?, servingSizeUnit? }]` — the compared foods in order
- `nutrients: array` — one entry per nutrient, each:
  - `id: number`
  - `name: string` — from the first food reporting the requested ID, else the nutrient reference, never from a fill source
  - `unit: string`
  - `values: array` — one number (or null) per food, in same order as `foods`
- `missingData: array` optional — foods/nutrients where data was unavailable: `[{ fdcId, nutrientId }]`. A cell filled from an equivalent nutrient is listed in `substitutions`, not here.
- `substitutions: array` optional — default-row cells filled from an equivalent nutrient: `[{ fdcId, requested, used }]`, where `requested` is 1008 or 2000 and `used` is 2048 or 2047 for energy, 1063 for sugars; in `nutrients[]` then `foods[]` order. Absent when nothing was filled.
- `deferredIds: number[]` optional — distinct requested IDs FDC did not return before the call's deadline or kept failing on transiently, in request order. The comparison leaves them out: they appear in neither `foods` nor `missingData`. Absent when FDC answered every ID.

**Partial success:** If one or more FDC IDs are not found, the comparison proceeds with the IDs that returned data. A `not_found` entry is added to `missingData` for each missing ID (with `nutrientId: null`). The tool only throws `too_few_foods` when fewer than 2 IDs return data — i.e., 0 or 1 valid food. This means an agent passing 3 IDs where 1 is bad gets a valid 2-food comparison, not an error. IDs FDC does not return in time are deferred, not missing: when they leave fewer than 2 foods, the call fails with `retry_deadline_exceeded`, since the caller's move is a retry, not new IDs. When the answered and deferred foods together still number fewer than 2, no retry can make a comparison, so the call fails with `too_few_foods` and its data lists the `deferredIds`.

**Notice:** Deferred IDs lead the `notice`, naming them and the follow-up (`usda_get_food` for each, or the same call again). Each compared food not reported per 100 g adds a caveat to the `notice`: an `ml` food's column is per `basis.gramWeight` millilitres, compared without density conversion, and a food with no `basisUnit` has an unverified per-100 basis.

**format():** Renders a markdown table with food descriptions and FDC IDs as column headers (`Broccoli, raw (747447)`) and nutrient names (with units and ID) as row labels. Each cell shows the scaled value, or `—` when data is absent. Leads with a `**Basis:**` line carrying quantity, unit, and the exact gram weight (e.g., `100 oz (2834.95g)`), then a `**Filled from equivalent nutrients:**` list for any `substitutions`, a `**Missing data:**` note listing any `missingData` entries, a `**Deferred (not compared):**` line for `deferredIds`, and a `**Compared foods:**` list giving each food's type, label unit, and basis.

**Errors:**

| reason | code | when | retryable? |
|:-------|:-----|:-----|:-----------|
| `too_few_foods` | ValidationError | Fewer than 2 of the provided FDC IDs returned data | No — verify IDs from search results; tool proceeds with valid IDs, only throws when fewer than 2 succeed |
| `retry_deadline_exceeded` | Timeout | Deferrals left fewer than 2 foods: FDC returned fewer than 2 of the IDs within the call's 45 s budget | Yes — retry once; if it fails again, request fewer foods per call or fetch them one at a time with `usda_get_food` |

Upstream 429 bubbles as `RateLimited` and 5xx as `ServiceUnavailable` (both retryable). The comparison fetches its IDs like `usda_get_foods`: one `/foods` request whose 15 s attempt retries after fast transient failures, refetched one ID per request if that attempt times out, all inside one 45 s budget (see "A timed-out batch splits per ID"). A stalled upstream fails at the budget as `Timeout` with `reason: retry_deadline_exceeded`, or as that 429's `RateLimited` error when the last attempt to complete before the cut-off was a 429.

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

The FDC search endpoint can return large `foodNutrients[]` arrays. Search locally retains eight nutrient IDs: protein (1003), fat (1004), carbohydrate (1005), fiber (1079), energy kcal (1008), energy kJ (1062), and Atwater general/specific energy (2047/2048). Keeping both Atwater estimates avoids choosing between distinct measurements or relabeling them. Preserve available entries and source order; an empty preview is valid. Detail, batch, resources, and explicit comparison filters retain their complete profiles. This projection adds no upstream requests.

### Serving resolution preserves source provenance

Portions are ordered by ascending `sequenceNumber`, FDC's display order (its data dictionary defines the field as the order a portion is displayed in), because FDC returns `foodPortions` in no fixed order and the array-first entry is an arbitrary pick: food 169733 lists `2 oz` (57 g) first in the array, but its display-first portion is `1 cup` (38 g). Ties keep FDC's array order and unnumbered portions sort last. Survey (FNDDS) 2705753 has no sequence 1 and serves its lowest-numbered portion, `Quantity not specified` (105 g). `servingInfo`, `unit: "serving"`, `allPortions`, and the resource's `portions` all read this one order, so the serving is always the first listed portion.

The first valid actual portion in that order takes precedence. With no portion, Branded label sizes in `g`, `GRM`, or `GM` (case-insensitive) supply a gram weight only when positive and finite. Detail normalization carries label size, unit, and household text separately from actual portions. `servingInfo` describes the resolved source and `scaledTo` carries the multiplied gram basis; `allPortions` remains actual definitions. Volume labels require density, which is unavailable. Missing units are never assumed to be grams; IU and unsupported mass units (including milligram labels) require an explicit mass-unit request.

Portion descriptions follow one rule for every data type: Survey (FNDDS) `portionDescription` as sent, since it already carries the amount; otherwise the `amount`, the measure unit (FDC's `undetermined` placeholder dropped, `RACC` spelled out), and the modifier (all-digit FNDDS food codes dropped), space-joined, with `Serving` when nothing remains. `amount` is also returned on its own when FDC sends a positive one.

### Per-100 basis follows the label unit

FDC reports every non-Branded food per 100 g and converts Branded label data to a 100-unit basis by the label's serving unit: `g`/`GRM`/`GM` is per 100 g, `ml`/`MLT` is per 100 ml, and any other unit (`IU`, `MG`) or none establishes neither. `basisUnit` (`src/services/fdc/basis.ts`) carries that on every search row and food detail, absent for the last case, so the values are per 100 label units with the basis unverified. Stating "per 100g" for every food would mislabel Branded foods labeled in ml.

Scaling with `unit` multiplies from that basis. A mass unit requested on an ml or label-unit basis is applied to it unconverted, since no density is available, and a `notice` says so rather than rejecting the request. A Branded label serving supplies a gram weight only when its unit is `g`/`GRM`/`GM`, as above.

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

Both fetch through the same batch path. The formatting and output schema differ.

### Portion scaling in `usda_get_food` but not `usda_get_foods`

`usda_get_food` is the "nutrition facts for this food" tool — "how many calories in 200g of chicken?" is a natural single-food query. Scaling there makes sense.

`usda_get_foods` is the "fetch raw data for these IDs" tool — it's a batch data fetch, not a nutrition question. Agents calling it are doing their own analysis. Adding scaling would complicate the schema (per-food scale params?) with little gain. For scaled comparisons, `usda_compare_foods` with `quantity`+`unit` handles it.

### Nutrient filtering happens locally, never upstream

The `nutrients[]` param on `usda_get_food`, `usda_get_foods`, and `usda_compare_foods` takes FDC nutrient **ids** — the identifiers `usda_list_nutrients` hands out. FDC's own `nutrients` query/body parameter takes SR **numbers**, so forwarding the caller's ids matched nothing and every filtered call came back empty.

The filter is therefore applied only in `normalizeFoodDetail`, against `id`. The alternative — translating id → number through the static nutrient reference table — was rejected: that table's ids are known to disagree with live FDC for some entries, which would make response completeness depend on reference data that is independently in doubt.

Cost: a filtered request now fetches the full profile upstream (~40 KB vs ~3 KB for a two-nutrient SR Legacy food). The client-facing response is unaffected — it is still narrowed to the requested ids — so `nutrients[]` remains the right advice for keeping agent context small. Measured at the 20-id ceiling of `usda_get_foods`, an unfiltered SR Legacy batch returns in ~2.5 s against the 15 s attempt, so the extra bytes stay well inside budget there. Foundation records are the exception: FDC builds most of a full profile (`nutrientAnalysisDetails`) before sending a byte, and 20 of them outrun one attempt (see "A timed-out batch splits per ID").

### A timed-out batch splits per ID

A multi-ID `/foods` request keeps its 15 s attempt and its retries after fast failures (5xx, 429, network), but an attempt that times out is not retried as a batch: FDC rebuilds the whole response on every retry, so a retry restarts the same wait. Each ID is refetched as its own `{ fdcIds: [id] }` request instead, all inside the call's one 45 s budget. The split keys on the timeout, not on the data type, so an SR Legacy batch keeps its single request with the body unchanged and the server never needs to know a record's data type before fetching it. A heavy Foundation call can send up to 21 requests.

Single-ID refetches share one process-wide limit of 10 in flight, so concurrent calls on one server don't multiply the fan-out. A request for one record (`GET /food/{id}`, a one-ID batch, each refetch) is not cut at 15 s but runs to the deadline, so a record that takes longer than an attempt to build still answers, and a deferred ID always has a working follow-up through `usda_get_food`. IDs FDC has not answered at the deadline, or kept failing on transiently, go to `deferredIds` with a notice; an ID still queued for the limit at the deadline is deferred without being sent. A non-transient refetch failure (another 4xx) fails the call. When no ID answered, the call fails with the first failure the deadline did not cause (a 5xx or 429 that exhausted its retries), or with `retry_deadline_exceeded` when the deadline stopped them all. A fan-out spends one request of the hourly rate limit per ID.

### The default Sugars row uses id 2000, not 1063

FDC carries total sugars under two distinct nutrients: `2000` `Total Sugars` (number `269`) and `1063` `Sugars, Total` (number `269.3`). Both are correct entries and both belong in the reference table, but they are reported by different data types — sampled across 146 foods, `1063` appeared only in Foundation records, while `2000` covered SR Legacy, Survey (FNDDS), and Branded.

`DEFAULT_COMPARE_NUTRIENTS` therefore requests `2000`. Because `usda_search_foods` defaults to SR Legacy, the documented search → compare workflow would otherwise report the Sugars row missing on every default comparison while the value sat in the payload under the other id. A Foundation food reports sugars as `1063` and not `2000`, and reports energy as the Atwater estimates `2048` and `2047` and not `1008`, so a default comparison that mixed data types would leave those cells empty. Under the default list only, each such cell is therefore filled from the first equivalent nutrient the food reports (energy: `2048`, then `2047`; sugars: `1063`) and listed in `substitutions[]` with the ID used, so the fill is visible and not reported as missing data. The default fetch includes the fill sources, since the service filters profiles locally. An explicit `nutrients[]` is compared as given, without fills, and a food lacking a default nutrient under every equivalent is still reported through `missingData[]`.

### Data source defaults

`usda_search_foods` defaults to `dataType: ["SR Legacy"]` because:
- SR Legacy has complete analytical nutrient profiles (Foundation, FNDDS are similar but smaller)
- Branded is ~50× larger, noisier, and often has sparse nutrient data
- Most nutrition questions are about generic foods ("banana", "salmon", "oats"), not branded products
- Branded search burns more rate-limit budget due to hit volume

Agents that need branded can opt in explicitly. The tool description makes this choice visible.

**Exception: `brandOwner` implies Branded.** When `brandOwner` is set and `dataType` is omitted, the default flips to `["Branded"]`. Only Branded records carry a `brandOwner` field, so the SR Legacy default made that combination structurally unmatchable — a brand search would return zero hits for any brand, on any query. An explicit `dataType` always wins, including a non-Branded one; that combination still resolves through the normal `no_results` path rather than a new error.

**Exception: a bare code implies Branded and Survey (FNDDS).** When `dataType` is omitted and the trimmed query is 8–14 digits alone, the default is `["Branded", "Survey (FNDDS)"]`: such a query is a UPC/GTIN barcode (a Branded `gtinUpc`) or an 8-digit FNDDS food code, and neither exists in SR Legacy. An explicit `dataType` wins, and `brandOwner` with a bare code searches Branded only.

### UPC/GTIN lookup recovers the stored forms

FDC matches `gtinUpc` as the exact stored string, and Branded records store one GTIN as 12, 13, or 14 digits (zero-padded) or as the 12-digit UPC-A without its check digit, so a printed UPC-A often finds nothing: `044500975932` returns no hit while 2739667 stores `00044500975932`, and `021140297051` finds 2078244 only as the stored `02114029705`. A bare 12-, 13-, or 14-digit query with a valid GS1 check digit is therefore sent as one OR query of the code as given, its other 12-, 13-, and 14-digit forms (leading zeros added or dropped, never below 12 digits), and the 12-digit form without its check digit when one exists. It stays one upstream call, and rows keep the stored `gtinUpc`, so the caller sees which form matched. The expansion passes through FDC's query handling unescaped.

Every other query goes out as given, 8–11-digit codes and check-failing codes included. Padding an 8–11-digit code would collide with other products' GTINs, and a code that fails its check digit is not a valid GTIN to expand. The `no_results` message and hint name the caller's query, never the expansion, and a bare 8–14-digit query that finds nothing gets a hint toward a product-name search with `dataType: ["Branded"]`.

---

## Known Limitations

- **Nutrient-ranked search not supported.** The API has no server-side sort by nutrient value. "Foods highest in X" queries aren't feasible without bulk download.
- **SR Legacy is a final release (April 2018).** Data is stable but not updated for new foods. Use Foundation or Branded for more recent data.
- **Branded nutrient data sparsity.** Not all branded products have complete nutrient profiles — many have only the label macros. `usda_get_food` on a branded item may return far fewer nutrients than an SR Legacy item.
- **Branded basis can be unverified.** A Branded label in a unit other than `g`/`GRM`/`GM` or `ml`/`MLT` (or with no unit) leaves `basisUnit` absent: FDC computed the values per 100 of that label unit, which this server cannot convert to grams or millilitres.
- **Search reaches 100,000 results.** FDC serves no result past the first 100,000 of a search, however many foods match; narrowing the query or filters is the only way to reach the rest.
- **Foundation records build slowly.** FDC assembles a Foundation record's full profile before it sends a byte, so a batch of them can outrun the 15 s batch attempt and is then fetched one ID per request. IDs FDC still has not answered at the 45 s deadline come back in `deferredIds`; fetch them with `usda_get_food`, which runs to the deadline.
- **Per-serving data quality varies.** Portion descriptions in SR Legacy (`"4 oz"`, `"1 package"`) are inconsistently structured — `modifier` is a free string, and some portions carry FDC's `undetermined` measure-unit placeholder. Serving uses the valid portion FDC displays first (lowest `sequenceNumber`) or, for Branded records without portions, a supported gram-label serving. Volume, missing units, invalid sizes, and unsupported label units retain `no_portion_data`.
- **Rate limit.** 1,000 req/hour with a real API key. Multi-food comparisons across large datasets are feasible; bulk analysis loops are not.
- **No image data.** FDC is purely composition data.

---

## API Reference

**Base URL:** `https://api.nal.usda.gov/fdc/v1`

**Auth:** `X-Api-Key` request header on all requests (never the `api_key` query parameter, so the key stays out of URLs and error messages).

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
- Do NOT use `format: "abridged"` — abridged keys nutrients by SR number with no nutrient id and omits portions
- Batch size: 20 distinct FDC IDs per request. FDC accepts more, but large batches of full profiles approach the 15 s batch attempt and produce very large responses; `usda_get_foods` defers the rest to `deferredIds`
- A batch attempt cut at 15 s is refetched one `{ fdcIds: [id] }` request per ID under the call's 45 s budget; one-record requests run to the deadline
- FDC answers HTTP 200 with `{}` rather than `[]` when it knows none of the requested IDs; the service reads that as zero matches

**Nutrient values:** Amounts are per 100 of `basisUnit` (per 100 g for every non-Branded food). Scale by `(quantity / 100)` for other amounts.

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
2. `FdcService` — search, single-food GET, batch GET with per-ID split on a timed-out attempt, retry ladder bounded by a 45 s total deadline, rate-limit handling, search-query escaping
3. Static nutrient reference data (embedded lookup table for `usda_list_nutrients`)
4. `usda_list_nutrients` (no API call — static data)
5. `usda_search_foods`
6. `usda_get_food` with portion scaling logic
7. `usda_get_foods` (batch)
8. `usda_compare_foods` (uses batch internally, adds pivot + format)
9. Resources (`usda://food/{fdcId}`, `usda://nutrients`)
