---
name: usda-guide
description: Use usda_* tools for food comparisons, portion-based nutrition, and packaged-food lookups when preparation, serving weights, or missing nutrients affect the answer. Establish matching food records and measurement bases before drawing conclusions.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use USDA FoodData Central for a specified food's composition or a bounded comparison. It does not provide nutrient-ranked search: a few keyword matches cannot establish which foods have the most of a nutrient across the database.

## Identifiers

Food `fdcId`, nutrient `id`, and legacy nutrient `number` identify different things. Use the nutrient `id` from `usda_list_nutrients` or a returned food profile for nutrient filtering; never substitute its legacy `number` or a food ID. If a nutrient filter unexpectedly returns nothing, inspect the unfiltered profile before concluding the nutrient is unavailable: related nutrient names can have distinct IDs.

## Gates

- Match the selected record's description to the requested preparation and edible form before using its values. Resolve a branded product by its description and available brand information rather than taking the first keyword match.
- Check the nutrient basis before answering. Search values are per 100g even when the result also shows a product-label serving. A preview omitting a nutrient does not establish its absence; use `usda_get_food` for the full profile.
- Inspect `servingInfo` before treating a serving as the user's household measure. The first defined portion is not automatically the requested cup, piece, or package. For another listed portion, use its gram weight explicitly. Do not infer a gram weight from a volume label without a known conversion.
- Check `missingData` and `failed` before reporting a complete comparison or meal total. Missing values are unavailable, never zero; a nutrient row can be absent when no compared food reports it.
- Keep comparison conclusions tied to the returned foods and common measurement basis. Equal-mass comparisons do not establish which food supplies more in the user's unequal portions.

## Workflows

**Comparable foods:** Select records matching each requested preparation, then compare the requested nutrients on a common mass basis. Report missing coverage alongside the comparison.

**Packaged product or household portion:** Confirm the product identity, inspect its serving description and gram weight, then scale to the requested amount. If the available serving does not match the user's measure and no gram weight is known, ask for the weight before giving a portion total.

**Meal with unequal portions:** Establish each ingredient's record and gram amount, retrieve its scaled nutrients, then sum matching nutrient IDs and units. If any ingredient lacks a requested nutrient or fails retrieval, identify the incomplete coverage rather than presenting the sum as a complete meal total.
