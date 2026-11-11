/**
 * @fileoverview The per-100 basis table every food surface shares: which label
 * units put a Branded food per 100 g or per 100 ml, and how the basis reads.
 * Tool tests prove only their wiring to these helpers.
 * @module tests/services/fdc/basis.test
 */

import { describe, expect, it } from 'vitest';
import { basisLabel, basisUnitFor, labelUnitBasis } from '@/services/fdc/basis.js';

describe('labelUnitBasis', () => {
  it.each([
    ['g', 'g'],
    ['G', 'g'],
    ['GRM', 'g'],
    ['grm', 'g'],
    ['gRm', 'g'],
    ['GM', 'g'],
    ['gm', 'g'],
    ['Gm', 'g'],
    ['ml', 'ml'],
    ['ML', 'ml'],
    ['Ml', 'ml'],
    ['mL', 'ml'],
    ['MLT', 'ml'],
    ['mlt', 'ml'],
  ])('reads label unit %j as per 100 %s', (unit, expected) => {
    expect(labelUnitBasis(unit)).toBe(expected);
  });

  /** FDC divides IU and MG labels by the label size too, so neither establishes grams. */
  it.each([
    'IU',
    'MG',
    'mg',
    'KG',
    'oz',
    'ONZ',
    'L',
    'gram',
    'milliliter',
    ' g',
    'g ',
    'ml ',
    '',
    undefined,
  ])('leaves label unit %j unverified', (unit) => {
    expect(labelUnitBasis(unit)).toBeUndefined();
  });

  /**
   * The gram-label serving check `usda_get_food` 0.2.0 ran inline, kept as the
   * reference the helper must match unit for unit.
   */
  const servingCheck = (unit: string) => ['g', 'grm', 'gm'].includes(unit.toLowerCase());

  it.each([
    'g',
    'G',
    'GRM',
    'gRm',
    'GM',
    'Gm',
    'grams',
    ' g',
    'g ',
    'gr',
    'mg',
    'MG',
    'ml',
    'MLT',
    'IU',
    '',
  ])('agrees with the 0.2.0 gram-label serving check on %j', (unit) => {
    expect(labelUnitBasis(unit) === 'g').toBe(servingCheck(unit));
  });
});

describe('basisUnitFor', () => {
  it.each(['SR Legacy', 'Foundation', 'Survey (FNDDS)', 'Experimental', 'Unknown'])(
    'puts %s foods per 100 g whatever the label unit',
    (dataType) => {
      expect(basisUnitFor(dataType, undefined)).toBe('g');
      expect(basisUnitFor(dataType, 'ml')).toBe('g');
      expect(basisUnitFor(dataType, 'IU')).toBe('g');
    },
  );

  it.each([
    ['GRM', 'g'],
    ['MLT', 'ml'],
    ['IU', undefined],
    [undefined, undefined],
  ])('reads a Branded food with label unit %j by its label', (unit, expected) => {
    expect(basisUnitFor('Branded', unit)).toBe(expected);
  });
});

describe('basisLabel', () => {
  it.each([
    ['g', undefined, 'per 100g'],
    ['g', 'GRM', 'per 100g'],
    ['ml', 'MLT', 'per 100 ml'],
    [undefined, 'IU', 'per 100 IU label units (basis unverified)'],
    [undefined, ' MG ', 'per 100 MG label units (basis unverified)'],
    [undefined, undefined, 'per 100 label units (basis unverified, no label unit)'],
    [undefined, '  ', 'per 100 label units (basis unverified, no label unit)'],
  ] as const)('renders basis %j with label unit %j as %j', (basisUnit, unit, expected) => {
    expect(basisLabel(basisUnit, unit)).toBe(expected);
  });
});
