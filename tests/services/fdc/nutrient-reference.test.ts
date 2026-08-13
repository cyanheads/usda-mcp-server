/**
 * @fileoverview Tests for the static FDC nutrient reference table and its accessors.
 * @module tests/services/fdc/nutrient-reference.test
 */

import { describe, expect, it } from 'vitest';
import {
  getNutrientsByCategory,
  NUTRIENT_BY_ID,
  NUTRIENT_REFERENCE,
} from '@/services/fdc/nutrient-reference.js';
import type { NutrientCategory } from '@/services/fdc/types.js';

/** The full `NutrientCategory` union — the table must populate every member. */
const CATEGORIES: readonly NutrientCategory[] = [
  'macronutrients',
  'vitamins',
  'minerals',
  'lipids',
  'amino_acids',
  'other',
];

describe('NUTRIENT_BY_ID', () => {
  it('indexes every row — no id is shadowed by a later duplicate', () => {
    expect(NUTRIENT_BY_ID.size).toBe(NUTRIENT_REFERENCE.length);
  });

  it('round-trips each row by its own id', () => {
    const mismatched = NUTRIENT_REFERENCE.filter((n) => NUTRIENT_BY_ID.get(n.id) !== n);
    expect(mismatched).toEqual([]);
  });
});

describe('getNutrientsByCategory', () => {
  it('returns the whole table when no category is given', () => {
    expect(getNutrientsByCategory()).toEqual(NUTRIENT_REFERENCE);
  });

  it('returns exactly the rows carrying that category', () => {
    for (const category of CATEGORIES) {
      expect(getNutrientsByCategory(category)).toEqual(
        NUTRIENT_REFERENCE.filter((n) => n.category === category),
      );
    }
  });

  it('populates every declared category', () => {
    const empty = CATEGORIES.filter((c) => getNutrientsByCategory(c).length === 0);
    expect(empty).toEqual([]);
  });

  it('assigns every row to a declared category', () => {
    const stray = NUTRIENT_REFERENCE.filter((n) => !CATEGORIES.includes(n.category));
    expect(stray).toEqual([]);
  });
});
