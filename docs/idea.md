# usda-mcp-server

MCP server for USDA FoodData Central — nutritional composition of foods.

## Why

Agents answering questions about nutrition, diet, cooking, food science, or health need structured food composition data. "How much protein is in chicken breast?", "Compare iron content of spinach vs kale", "What foods are high in vitamin D?" — total gap in current server inventory.

## Source

- **API:** USDA FoodData Central API (https://fdc.nal.usda.gov/api-guide)
- **Auth:** Free API key (https://fdc.nal.usda.gov/api-key-signup) — required
- **Rate limits:** 3,600 requests/hour with key
- **Docs:** https://fdc.nal.usda.gov/api-guide

## Scope

### Data sources within FDC

| Source | Description | Use case |
|---|---|---|
| SR Legacy | USDA Standard Reference — ~7,900 common foods with full nutrient profiles | General nutrition lookups |
| Foundation | High-quality analytical data with sample and method details | Research, precision queries |
| Survey (FNDDS) | Foods as consumed in dietary surveys, with portion weights | Diet analysis |
| Branded | ~400K branded/packaged products with label data | Product-specific lookups |

### Core tools

| Tool | Description |
|---|---|
| `usda_search_foods` | Search foods by name, with optional data source and food category filters |
| `usda_get_food` | Full nutrient profile for a specific food by FDC ID — all nutrients, portions, data source details |
| `usda_get_nutrients` | Specific nutrients for a food (e.g., just protein, fat, carbs, calories) — lighter than full profile |
| `usda_list_nutrients` | Available nutrient types and their IDs/units (there are ~150 tracked nutrients) |
| `usda_search_branded` | Search branded/packaged foods by name, brand, or UPC/GTIN code |

### Potential additions

- **`usda_compare_foods`** — side-by-side nutrient comparison of 2+ foods
- **`usda_foods_by_nutrient`** — "what foods are highest in X?" sorted by nutrient density
- Food category browsing/filtering

## Design notes

- The API returns nutrient values per 100g by default. Portion/serving size data is available in the `foodPortions` array — surface both per-100g and per-serving when portions exist.
- Nutrient IDs are numeric (e.g., 1003 = protein, 1008 = energy). The `usda_list_nutrients` tool is essential for discoverability.
- Branded food data is huge (~400K items) and noisy. Search within branded should support brand name filtering to narrow results.
- SR Legacy is the most generally useful dataset for agents — it covers common whole foods with complete nutrient profiles. Default searches here unless the user specifies branded.
- Food descriptions in SR Legacy use USDA conventions (e.g., "Chicken, broilers or fryers, breast, skinless, boneless, meat only, raw"). These are precise but unfamiliar to casual users — search should be fuzzy/keyword-based.
