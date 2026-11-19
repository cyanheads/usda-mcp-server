/**
 * @fileoverview Tests for the per-nutrient provenance helpers: what is read
 * from an FDC detail or batch nutrient row, and how it renders in `content[]`.
 * The tools and the service prove only their wiring to these.
 * @module tests/services/fdc/provenance.test
 */

import { describe, expect, it } from 'vitest';
import { nutrientProvenance, provenanceText } from '@/services/fdc/provenance.js';
import type { RawFoodNutrient } from '@/services/fdc/types.js';

/** A row as `JSON.parse` hands it over, so a `null` FDC might send reaches the reader as sent. */
const row = (json: string) => JSON.parse(json) as RawFoodNutrient;

const ANALYTICAL = {
  code: 'A',
  description: 'Analytical',
  foodNutrientSource: { code: '1', description: 'Analytical or derived from analytical' },
};

describe('nutrientProvenance', () => {
  it('reads a Foundation row whole: derivation, source, count, and spread', () => {
    expect(
      nutrientProvenance({
        foodNutrientDerivation: ANALYTICAL,
        amount: 254,
        dataPoints: 5,
        max: 281,
        min: 203,
        median: 264,
      }),
    ).toStrictEqual({
      derivation: {
        code: 'A',
        description: 'Analytical',
        source: 'Analytical or derived from analytical',
      },
      dataPoints: 5,
      min: 203,
      max: 281,
      median: 264,
    });
  });

  it('returns nothing for a row FDC sends none of it on, never an empty or zero value', () => {
    expect(nutrientProvenance({ amount: 26.7 })).toStrictEqual({});
  });

  it('keeps every value FDC sends as 0', () => {
    expect(
      nutrientProvenance({ amount: 0, dataPoints: 0, min: 0, max: 0, median: 0 }),
    ).toStrictEqual({ dataPoints: 0, min: 0, max: 0, median: 0 });
  });

  it('infers no derivation from a sample count', () => {
    expect(nutrientProvenance({ amount: 31.02, dataPoints: 16 })).toStrictEqual({ dataPoints: 16 });
  });

  it.each([
    ['null', '{"amount":1,"dataPoints":null,"min":null,"max":null,"median":null}'],
    ['a null derivation', '{"amount":1,"foodNutrientDerivation":null}'],
    ['an empty derivation', '{"amount":1,"foodNutrientDerivation":{}}'],
    ['no code', '{"amount":1,"foodNutrientDerivation":{"description":"Calculated"}}'],
    [
      'a blank code',
      '{"amount":1,"foodNutrientDerivation":{"code":"  ","description":"Calculated"}}',
    ],
    ['no description', '{"amount":1,"foodNutrientDerivation":{"code":"NC"}}'],
    ['a blank description', '{"amount":1,"foodNutrientDerivation":{"code":"NC","description":""}}'],
  ])('leaves out what FDC sends as %s', (_label, json) => {
    expect(nutrientProvenance(row(json))).toStrictEqual({});
  });

  it.each([
    ['no source', '{"code":"NC","description":"Calculated"}'],
    ['a null source', '{"code":"NC","description":"Calculated","foodNutrientSource":null}'],
    [
      'a source without a description',
      '{"code":"NC","description":"Calculated","foodNutrientSource":{"code":"4"}}',
    ],
    [
      'a blank source description',
      '{"code":"NC","description":"Calculated","foodNutrientSource":{"description":"\\t"}}',
    ],
  ])('keeps a derivation with %s, leaving its source out', (_label, derivation) => {
    expect(
      nutrientProvenance(row(`{"amount":1,"foodNutrientDerivation":${derivation}}`)),
    ).toStrictEqual({ derivation: { code: 'NC', description: 'Calculated' } });
  });

  it('trims the derivation text FDC sends', () => {
    expect(
      nutrientProvenance({
        foodNutrientDerivation: {
          code: ' Z ',
          description: ' Assumed zero ',
          foodNutrientSource: { description: ' Assumed zero\n' },
        },
      }),
    ).toStrictEqual({
      derivation: { code: 'Z', description: 'Assumed zero', source: 'Assumed zero' },
    });
  });

  it('keeps a lone bound as sent, never inventing the other', () => {
    expect(nutrientProvenance({ min: 4 })).toStrictEqual({ min: 4 });
    expect(nutrientProvenance({ max: 4.2 })).toStrictEqual({ max: 4.2 });
  });
});

describe('provenanceText', () => {
  const derivation = {
    code: 'A',
    description: 'Analytical',
    source: 'Analytical or derived from analytical',
  };

  it.each([
    [
      'every part',
      { derivation, dataPoints: 5, min: 203, max: 281, median: 264 },
      ' — A: Analytical; source: Analytical or derived from analytical; n=5; range 203–281; median 264',
    ],
    [
      'a derivation without a source',
      { derivation: { code: 'NC', description: 'Calculated' }, min: 2.25, max: 3.81, median: 3.06 },
      ' — NC: Calculated; range 2.25–3.81; median 3.06',
    ],
    ['a sample count of 0 alone', { dataPoints: 0 }, ' — n=0'],
    [
      'a range without a median',
      { dataPoints: 15, min: 10.01, max: 13.24 },
      ' — n=15; range 10.01–13.24',
    ],
    ['a median alone', { median: 3.06 }, ' — median 3.06'],
    ['a spread of zeros', { min: 0, max: 0, median: 0 }, ' — range 0–0; median 0'],
    ['a lone min', { min: 4 }, ' — min 4'],
    ['a lone max', { max: 4.2, median: 4.1 }, ' — max 4.2; median 4.1'],
    ['nothing', {}, ''],
  ])('renders %s', (_label, fields, expected) => {
    expect(provenanceText(fields)).toBe(expected);
  });

  it('escapes FDC text and leaves the numbers as structuredContent carries them', () => {
    expect(
      provenanceText({
        derivation: { code: 'A*', description: 'Lab [x] | <b>', source: '_src_' },
        dataPoints: 2,
      }),
    ).toBe(' — A\\*: Lab \\[x\\] \\| \\<b>; source: \\_src\\_; n=2');
  });
});
