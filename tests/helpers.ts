/**
 * @fileoverview Shared narrowing helpers for definition tests. Keeps `format()`
 * assertions type-safe under `noUncheckedIndexedAccess` without non-null
 * assertions, and fails loudly when a block is absent or not text.
 * @module tests/helpers
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';

/**
 * Text of the leading content block — the assertion every `format()` test
 * implicitly makes. Throws when the array is empty or the block is not text.
 */
export function firstText(blocks: readonly ContentBlock[]): string {
  const block = blocks[0];
  if (block?.type !== 'text') {
    throw new Error(`Expected a leading text content block, received: ${block?.type ?? 'none'}`);
  }
  return block.text;
}
