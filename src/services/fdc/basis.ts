/**
 * @fileoverview The per-100 basis of a food's nutrient values. FDC reports
 * every non-Branded food per 100 g and converts Branded label data "to a
 * 100-unit basis, either gram (g) or milliliter (ml)" by the label's serving
 * unit, so a volume label is per 100 ml and an `IU` or `MG` label is per 100 of
 * a unit that establishes neither.
 * @module services/fdc/basis
 */

/** The unit a food's per-100 nutrient values are measured in. */
export type BasisUnit = 'g' | 'ml';

/** The `basisUnit` output field description shared by the detail, batch, and compare tools. */
export const BASIS_UNIT_DESCRIPTION =
  'What the per-100 nutrient values are measured in: "g" for every non-Branded food and for Branded labels in g/GRM/GM, "ml" for Branded labels in ml/MLT. Absent when the label unit (e.g. IU, MG) fixes neither, so the basis is unverified.';

/** The `servingSizeUnit` output field description shared by the batch and compare tools. */
export const LABEL_UNIT_DESCRIPTION =
  'Label serving unit as FDC reports it (e.g. "GRM", "MLT", "IU"); it sets basisUnit. Branded items only.';

/** FDC's label serving units, lowercased, that fix the basis. */
const LABEL_UNIT_BASIS = new Map<string, BasisUnit>([
  ['g', 'g'],
  ['grm', 'g'],
  ['gm', 'g'],
  ['ml', 'ml'],
  ['mlt', 'ml'],
]);

/**
 * The basis a Branded label's serving unit puts the food's values on, matched
 * case-insensitively and untrimmed: `g`/`GRM`/`GM` → `'g'`, `ml`/`MLT` → `'ml'`,
 * any other unit or none → `undefined`.
 */
export function labelUnitBasis(servingSizeUnit: string | undefined): BasisUnit | undefined {
  return servingSizeUnit ? LABEL_UNIT_BASIS.get(servingSizeUnit.toLowerCase()) : undefined;
}

/** `'g'` for every non-Branded food; a Branded food's basis is its label unit's. */
export function basisUnitFor(
  dataType: string,
  servingSizeUnit: string | undefined,
): BasisUnit | undefined {
  return dataType === 'Branded' ? labelUnitBasis(servingSizeUnit) : 'g';
}

/**
 * The basis as plain text for a tool's `content[]`: `per 100g`, `per 100 ml`,
 * or, with no verified basis, `per 100 {servingSizeUnit} label units (basis
 * unverified)`. The label unit is interpolated trimmed but unescaped, so a
 * Markdown caller escapes the whole label.
 */
export function basisLabel(
  basisUnit: BasisUnit | undefined,
  servingSizeUnit: string | undefined,
): string {
  switch (basisUnit) {
    case 'g':
      return 'per 100g';
    case 'ml':
      return 'per 100 ml';
    case undefined: {
      const unit = servingSizeUnit?.trim();
      return unit
        ? `per 100 ${unit} label units (basis unverified)`
        : 'per 100 label units (basis unverified, no label unit)';
    }
  }
}
