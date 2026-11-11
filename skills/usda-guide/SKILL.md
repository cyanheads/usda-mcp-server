---
name: usda-guide
description: Use usda_* tools for food comparisons, portion-based nutrition, and packaged-food lookups when preparation, serving weights, or missing nutrients affect the answer. Establish matching food records and measurement bases before drawing conclusions.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.1"
---

## Scope

Use USDA FoodData Central for a specified food's composition or a bounded comparison. It does not provide nutrient-ranked search: a few keyword matches cannot establish which foods have the most of a nutrient across the database.

## Identifiers

Food `fdcId`, nutrient `id`, and legacy nutrient `number` identify different things. Use the nutrient `id` from `usda_list_nutrients` or a returned food profile for nutrient filtering; never substitute its legacy `number` or a food ID. If a nutrient filter unexpectedly returns nothing, check the food's `missingNutrients` and inspect the unfiltered profile before concluding the nutrient is unavailable: related nutrient names can have distinct IDs.

## Gates

- Match the selected record's description to the requested preparation and edible form before using its values. Resolve a branded product by its description and available brand information rather than taking the first keyword match.
- Check the nutrient basis before answering. Values are per 100 of `basisUnit`, even when the result also shows a product-label serving: `g`, or `ml` for a Branded label in ml. An absent `basisUnit` means the label unit (IU, MG, or none) fixes neither, so the values are per 100 label units with the basis unverified; do not report them as per 100 g. A mass-unit request on an ml or label-unit basis is applied unconverted, and the returned notice says so. A preview omitting a nutrient does not establish its absence; use `usda_get_food` for the full profile.
- `missingNutrients` lists the requested nutrient IDs a food's profile does not report. Treat them as unreported for that ID, not as zero, and not as proof the nutrient is absent from the food.
- Find a packaged product by barcode with the UPC/GTIN digits alone as the query. The match is exact on the stored `gtinUpc`, leading zeros included, and the same digits can instead match an 8-digit Survey (FNDDS) food code, so confirm the returned `gtinUpc` and description before using the record. A multi-word query matches foods holding any one word unless `requireAllWords` is set, so check each result's description against the whole request.
- Search reaches only the first 100,000 results. A page past that window fails with `result_window_exceeded`; narrow the query or filters rather than concluding the rest does not exist.
- Inspect `servingInfo` before treating a serving as the user's household measure. The first defined portion is not automatically the requested cup, piece, or package. For another listed portion, use its gram weight explicitly. Do not infer a gram weight from a volume label without a known conversion.
- Check `missingData`, `failed`, and `substitutions` before reporting a complete comparison or meal total. Missing values are unavailable, never zero; a nutrient row can be absent when no compared food reports it. A `substitutions` entry means a default energy or total-sugars cell came from an equivalent nutrient (`used`), not the one requested. While `deferredIds` remain from `usda_get_foods`, those foods were not fetched, so any total or comparison is incomplete.
- Keep comparison conclusions tied to the returned foods and common measurement basis. Equal-mass comparisons do not establish which food supplies more in the user's unequal portions.

## Workflows

**Comparable foods:** Select records matching each requested preparation, then compare the requested nutrients on a common mass basis. Report missing coverage alongside the comparison.

**Packaged product or household portion:** Confirm the product identity, inspect its serving description and gram weight, then scale to the requested amount. If the available serving does not match the user's measure and no gram weight is known, ask for the weight before giving a portion total.

**Meal with unequal portions:** Establish each ingredient's record and gram amount, retrieve its scaled nutrients, then sum matching nutrient IDs and units. If any ingredient lacks a requested nutrient, fails retrieval, or is left in `deferredIds`, identify the incomplete coverage rather than presenting the sum as a complete meal total.
