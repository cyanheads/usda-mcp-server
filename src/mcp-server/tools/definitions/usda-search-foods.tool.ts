/**
 * @fileoverview Search USDA FoodData Central foods by keyword, with a preview of key nutrients.
 * @module mcp-server/tools/definitions/usda-search-foods
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { basisLabel } from '@/services/fdc/basis.js';
import { FDC_RESULT_WINDOW, getFdcService, isWildcardFilter } from '@/services/fdc/fdc-service.js';
import type { FdcDataType } from '@/services/fdc/types.js';

/** FDC's result window as prose reads it: `100,000`. */
const WINDOW_TEXT = FDC_RESULT_WINDOW.toLocaleString('en-US');

/**
 * The data sources a search without `dataType` covers. Only Branded records
 * carry a brandOwner, so a brand search goes there. A query of 8–14 digits
 * alone is a UPC/GTIN barcode (a Branded `gtinUpc`) or an 8-digit Survey
 * (FNDDS) food code. Anything else searches SR Legacy.
 */
function defaultDataType(query: string, brandOwner: string | undefined): FdcDataType[] {
  if (brandOwner) return ['Branded'];
  // The length gate keeps the digit test off long queries.
  if (query.length >= 8 && query.length <= 14 && /^\d+$/.test(query)) {
    return ['Branded', 'Survey (FNDDS)'];
  }
  return ['SR Legacy'];
}

export const usdaSearchFoods = tool('usda_search_foods', {
  title: 'Search USDA Foods',
  description:
    'Search USDA FoodData Central foods by keyword. Returns matching foods with FDC IDs and available preview nutrients: protein (1003), fat (1004), carbohydrate (1005), fiber (1079), and energy (1008, 1062, 2047, 2048), preserving distinct energy estimates. Missing nutrients are omitted. Use the returned fdcId with usda_get_food for other nutrients or the full profile, or usda_compare_foods for side-by-side comparisons. When dataType is omitted, defaults to SR Legacy (common whole foods with complete profiles), to Branded when brandOwner is set (only Branded records carry one), or to Branded and Survey (FNDDS) when the query is 8–14 digits alone (a UPC/GTIN barcode or an FNDDS food code). Set dataType to ["Branded"] for packaged products. Pass brandOwner (e.g. "General Mills") to narrow branded results.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'Search terms — food name, ingredient, or UPC/GTIN code. Examples: "chicken breast raw", "banana", "02114029705". A food matching any one unqualified word counts, so a multi-word query also returns foods holding only some of its words; set requireAllWords, or prefix each word with +, to require them all. A query of 8–14 digits alone matches a Branded UPC/GTIN code exactly as FDC stores it, leading zeros included, or an 8-digit Survey (FNDDS) food code. FDC reads Lucene syntax: "quoted phrases", +required and -excluded terms, AND/OR/NOT, wildcards (chick*), fuzzy matches (beeef~), boosts (beef^5), grouping parentheses, field:value, regex terms (/chick.*/), and ranges ([a TO c], {a TO c}). Any other slash, bracket, or brace (1/8, w/o, beef [raw]), any unpaired parenthesis, and every double quote when the query holds an odd number of them are sent as literal characters.',
      ),
    requireAllWords: z
      .boolean()
      .default(false)
      .describe(
        'Match only foods containing every query word (FDC requireAllWords). Default false: a food matching any one word counts. Explicit OR and "quoted phrases" keep their meaning.',
      ),
    dataType: z
      .array(z.enum(['SR Legacy', 'Foundation', 'Survey (FNDDS)', 'Branded']))
      .optional()
      .describe(
        'FDC data sources to search. Omitting this defaults to ["SR Legacy"] (common whole foods, complete nutrient profiles), to ["Branded"] when brandOwner is set, or to ["Branded", "Survey (FNDDS)"] when the query is 8–14 digits alone (a UPC/GTIN barcode or an FNDDS food code). Include "Branded" for packaged products. Multiple values allowed.',
      ),
    brandOwner: z
      .string()
      .optional()
      .describe(
        'Filter branded results by brand owner name (e.g. "General Mills", "Kraft"). Matched as one phrase, ignoring case and punctuation: "Kellogg Company" matches owners holding those words in that order. A value containing * or ? is sent as wildcard terms instead, each word matched on its own (e.g. "Kellog*"). For other operators, use field syntax in query (e.g. "+cereal +brandOwner:Kellog*"). Only Branded records carry one, so setting this defaults dataType to ["Branded"] unless dataType is given explicitly.',
      ),
    foodCategory: z
      .string()
      .optional()
      .describe(
        'Filter by USDA food category (e.g. "Poultry Products", "Vegetables and Vegetable Products"). Matched as one phrase, ignoring case and punctuation. A value containing * or ? is sent as wildcard terms instead, each word matched on its own (e.g. "Poult*"); a whole word followed by * can match nothing ("Poultry*" does), so shorten it. For other operators, use field syntax in query (e.g. chicken -foodCategory:"Fast Foods" excludes a category).',
      ),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Number of results per page. Default 10, maximum 50.'),
    pageNumber: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe(
        `Page number (1-based). Use with totalPages to paginate. FDC serves only the first ${WINDOW_TEXT} results of a search, so a page whose pageSize × pageNumber exceeds ${WINDOW_TEXT} fails with result_window_exceeded, naming the last reachable page, unless it is also past the last page. A page past the last returns empty foods with a notice naming the last reachable page when the query has matches.`,
      ),
  }),
  output: z.object({
    totalHits: z.number().describe('Total number of foods matching the query across all pages.'),
    currentPage: z
      .number()
      .describe('Current page number (1-based); the requested page for exhausted pages.'),
    totalPages: z
      .number()
      .describe(
        `Total number of pages at this pageSize, as FDC counts them. FDC serves only the first ${WINDOW_TEXT} results of a search, so when totalHits exceeds ${WINDOW_TEXT}, pages past ${WINDOW_TEXT} / pageSize (rounded down) are out of reach.`,
      ),
    foods: z
      .array(
        z
          .object({
            fdcId: z
              .number()
              .describe('FDC ID — pass to usda_get_food, usda_get_foods, or usda_compare_foods.'),
            description: z
              .string()
              .describe(
                'USDA food description (e.g. "Chicken, broilers or fryers, breast, meat only, raw").',
              ),
            dataType: z
              .string()
              .describe('FDC data source: SR Legacy, Foundation, Survey (FNDDS), or Branded.'),
            // `ml` leads: format-parity probes the first member as a token, and `per 100g` holds no `g` token.
            basisUnit: z
              .enum(['ml', 'g'])
              .optional()
              .describe(
                'What the nutrient amounts are per 100 of: "g" for every non-Branded food and for Branded labels in g, GRM, or GM; "ml" for Branded labels in ml or MLT. Absent when the Branded label unit (e.g. IU, MG), or its absence, fixes neither: the amounts are then per 100 label units, basis unverified.',
              ),
            foodCategory: z
              .string()
              .optional()
              .describe(
                'USDA food category (e.g. "Poultry Products"). Absent for some branded items.',
              ),
            brandOwner: z
              .string()
              .optional()
              .describe('Brand owner name. Present for Branded items only.'),
            brandName: z
              .string()
              .optional()
              .describe('Brand name. Present for Branded items only.'),
            gtinUpc: z
              .string()
              .optional()
              .describe(
                'UPC/GTIN barcode as FDC stores it, leading zeros kept (e.g. "02114029705"). Branded only; a query of exactly these digits finds the product again.',
              ),
            servingSize: z
              .number()
              .optional()
              .describe('Serving size from the product label, in servingSizeUnit. Branded only.'),
            servingSizeUnit: z
              .string()
              .optional()
              .describe(
                'Unit for servingSize as FDC reports it (e.g. "GRM", "MLT", "IU"); it sets basisUnit. Branded only.',
              ),
            householdServingFullText: z
              .string()
              .optional()
              .describe(
                'Serving description as it appears on the label (e.g. "1 cup", "1 oz"). Branded only.',
              ),
            nutrients: z
              .array(
                z
                  .object({
                    id: z.number().describe('FDC nutrient ID.'),
                    name: z.string().describe('Nutrient name.'),
                    amount: z
                      .number()
                      .describe(
                        'Amount per 100 g, per 100 ml when basisUnit is "ml", or per 100 label units when basisUnit is absent.',
                      ),
                    unit: z.string().describe('Unit (e.g. "G", "MG", "KCAL").'),
                  })
                  .describe(
                    "A preview nutrient entry with ID, name, and amount on the food's per-100 basis (basisUnit).",
                  ),
              )
              .describe(
                "Available preview nutrients on the food's per-100 basis (basisUnit): protein (1003), fat (1004), carbohydrate (1005), fiber (1079), and energy (1008, 1062, 2047, 2048). Source order, values and distinct energy estimates are preserved. Missing entries are omitted; use usda_get_food for other nutrients.",
              ),
            publishedDate: z
              .string()
              .optional()
              .describe('Date the food entry was published in FDC.'),
          })
          .describe('A food item matching the search query.'),
      )
      .describe('Foods matching the search query.'),
  }),
  enrichment: {
    totalCount: z.number().describe('Total foods matching the query across all pages.'),
    notice: z
      .string()
      .optional()
      .describe(
        `Guidance when the requested page is past the last reachable page, or when more foods match than the first ${WINDOW_TEXT} FDC serves.`,
      ),
  },

  errors: [
    {
      reason: 'query_empty',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The query is empty or contains only whitespace.',
      recovery: 'Provide a food name, ingredient, or UPC/GTIN code as the query.',
      severity: 'notice',
    },
    {
      reason: 'query_syntax',
      code: JsonRpcErrorCode.ValidationError,
      when: 'FDC rejected the query syntax, e.g. a dangling operator or a trailing backslash.',
      recovery:
        'FDC rejected the query syntax. Remove a leading or trailing operator (AND, OR, -, !, ^) or a trailing backslash, or put a backslash before a character meant literally.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'No foods matched the query in the specified data sources.',
      recovery:
        'Broaden the query, check spelling, or try a different dataType (e.g. add "Branded").',
      severity: 'notice',
    },
    {
      reason: 'result_window_exceeded',
      code: JsonRpcErrorCode.ValidationError,
      when: `pageSize × pageNumber exceeds the first ${WINDOW_TEXT} results FDC serves for a search, on a page that holds matches.`,
      recovery: `Request a page whose pageSize × pageNumber is at most ${WINDOW_TEXT}, or narrow the query, dataType, brandOwner, or foodCategory to bring the foods you need inside the first ${WINDOW_TEXT} results.`,
      severity: 'notice',
    },
  ],

  async handler(input, ctx) {
    const trimmedQuery = input.query.trim();
    if (!trimmedQuery) {
      throw ctx.fail('query_empty', 'Query cannot be empty or whitespace-only.', {
        recovery: {
          hint: 'Provide a food name, ingredient, or UPC/GTIN code as the query.',
        },
      });
    }

    const brandOwner = input.brandOwner?.trim();
    const foodCategory = input.foodCategory?.trim();
    const dataType = input.dataType?.length
      ? input.dataType
      : defaultDataType(trimmedQuery, brandOwner);
    /**
     * FDC answers HTTP 400 to any page reaching past its result window, so
     * such a request fetches page 1 at the same pageSize instead: its totals
     * decide whether the requested page is past the end or out of reach.
     */
    const pastWindow = input.pageSize * input.pageNumber > FDC_RESULT_WINDOW;

    ctx.log.info('Searching foods', {
      query: trimmedQuery,
      dataType,
      pageSize: input.pageSize,
    });

    const result = await getFdcService().searchFoods(
      {
        query: trimmedQuery,
        dataType,
        pageSize: input.pageSize,
        pageNumber: pastWindow ? 1 : input.pageNumber,
        ...(brandOwner && { brandOwner }),
        ...(foodCategory && { foodCategory }),
        ...(input.requireAllWords && { requireAllWords: true }),
      },
      ctx,
    );

    const exhaustedPage = result.totalHits > 0 && input.pageNumber > result.totalPages;
    if (result.foods.length === 0 && !exhaustedPage) {
      const dtLabel = dataType.join(', ');
      const widen = dataType.includes('Branded')
        ? 'Try a simpler query or check spelling.'
        : 'Try a simpler query, check spelling, or add "Branded" to dataType.';
      // A filter can empty the result on its own, so the message and hint name every one sent.
      const filters: Array<[field: string, value: string]> = [];
      if (brandOwner) filters.push(['brandOwner', brandOwner]);
      if (foodCategory) filters.push(['foodCategory', foodCategory]);
      const withFilters = filters.length
        ? ` with ${filters.map(([field, value]) => `${field} "${value}"`).join(' and ')}`
        : '';
      const message = `No foods matched "${trimmedQuery}" in ${dtLabel}${withFilters}.`;
      const lead = input.requireAllWords
        ? 'Retry without requireAllWords so a food matching any one query word counts.'
        : message;
      const phraseFields = filters
        .filter(([, value]) => !isWildcardFilter(value))
        .map(([field]) => field);
      const wildcardFields = filters
        .filter(([, value]) => isWildcardFilter(value))
        .map(([field]) => field);
      const phraseAdvice = phraseFields.length
        ? ` A filter without * or ? must match as one phrase: check it against the ${phraseFields.join(' or ')} values an unfiltered search returns, or drop it.`
        : '';
      const wildcardAdvice = wildcardFields.length
        ? ` A wildcard can match nothing where a shorter one matches ("Poultry*" vs "Poult*"): shorten it, or drop the ${wildcardFields.join(' or ')} filter.`
        : '';
      const filterAdvice = `${phraseAdvice}${wildcardAdvice}`;
      throw ctx.fail('no_results', message, {
        query: trimmedQuery,
        dataType,
        recovery: { hint: `${lead}${filterAdvice} ${widen}` },
      });
    }

    const lastReachablePage = Math.min(
      result.totalPages,
      Math.floor(FDC_RESULT_WINDOW / input.pageSize),
    );
    const totalHitsText = result.totalHits.toLocaleString('en-US');
    if (pastWindow && !exhaustedPage) {
      throw ctx.fail(
        'result_window_exceeded',
        `Page ${input.pageNumber} at pageSize ${input.pageSize} is past the first ${WINDOW_TEXT} results FDC serves for "${trimmedQuery}".`,
        {
          query: trimmedQuery,
          pageSize: input.pageSize,
          pageNumber: input.pageNumber,
          totalHits: result.totalHits,
          lastReachablePage,
          recovery: {
            hint: `Retry with pageNumber: ${lastReachablePage} or lower at pageSize ${input.pageSize}, or narrow the query or filters: FDC serves only the first ${WINDOW_TEXT} results of a search, and this one matches ${totalHitsText}.`,
          },
        },
      );
    }

    // ctx.enrich.notice is last-wins, so every notice for this call goes out as one string.
    const notices: string[] = [];
    if (exhaustedPage) {
      notices.push(
        `Requested page ${input.pageNumber} is past the end. Valid pages are 1–${lastReachablePage}; retry with pageNumber: ${lastReachablePage}.`,
      );
    }
    if (result.totalHits > FDC_RESULT_WINDOW) {
      notices.push(
        `Only the first ${WINDOW_TEXT} of the ${totalHitsText} matching foods are reachable: FDC serves no page past ${lastReachablePage} at pageSize ${input.pageSize}. Narrow the query or filters to reach the rest.`,
      );
    }

    ctx.enrich.total(result.totalHits);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
    return {
      totalHits: result.totalHits,
      currentPage: exhaustedPage ? input.pageNumber : result.currentPage,
      totalPages: result.totalPages,
      foods: exhaustedPage ? [] : result.foods,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**${result.totalHits} total hits** — page ${result.currentPage} of ${result.totalPages}\n`,
    ];

    // FDC-supplied free text goes through escapeMarkdownInline so content[] reads back as written.
    for (const food of result.foods) {
      lines.push(`### ${escapeMarkdownInline(food.description)}`);
      lines.push(`**FDC ID:** ${food.fdcId} | **Type:** ${food.dataType}`);
      if (food.foodCategory) lines.push(`**Category:** ${escapeMarkdownInline(food.foodCategory)}`);
      if (food.brandOwner) lines.push(`**Brand Owner:** ${escapeMarkdownInline(food.brandOwner)}`);
      if (food.brandName) lines.push(`**Brand:** ${escapeMarkdownInline(food.brandName)}`);
      if (food.gtinUpc) lines.push(`**GTIN/UPC:** ${escapeMarkdownInline(food.gtinUpc)}`);
      if (food.servingSize != null) {
        lines.push(
          `**Serving:** ${food.servingSize}${food.servingSizeUnit ? escapeMarkdownInline(food.servingSizeUnit) : ''}${food.householdServingFullText ? ` (${escapeMarkdownInline(food.householdServingFullText)})` : ''}`,
        );
      }
      // Without preview nutrients, the basis still goes out on its own line.
      const basis = escapeMarkdownInline(basisLabel(food.basisUnit, food.servingSizeUnit));
      lines.push(
        food.nutrients.length > 0
          ? `**Nutrients (${basis}):** ${food.nutrients.map((n) => `${escapeMarkdownInline(n.name)} (ID:${n.id}): ${n.amount}${n.unit}`).join(' | ')}`
          : `**Basis:** ${basis}`,
      );
      if (food.publishedDate) lines.push(`**Published:** ${food.publishedDate}`);
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
