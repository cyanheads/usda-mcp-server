/**
 * @fileoverview Shared helpers for definition tests. Narrowing helpers keep
 * `format()` assertions type-safe under `noUncheckedIndexedAccess` without
 * non-null assertions and fail loudly when a block is absent or not text;
 * `fdcHttpError` builds the upstream error the service throws.
 * @module tests/helpers
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

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

/** Every text block of a tool result joined — `format()` output plus the enrichment trailer. */
export function allText(blocks: readonly ContentBlock[]): string {
  return blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

/**
 * The McpError `fetchWithTimeout` throws for a non-2xx FDC response: the
 * status-mapped code, plus `status` and its legacy `statusCode` alias.
 */
export function fdcHttpError(status: number, message: string): McpError {
  return new McpError(
    status === 404 ? JsonRpcErrorCode.NotFound : JsonRpcErrorCode.ServiceUnavailable,
    message,
    {
      status,
      statusText: status === 404 ? 'Not Found' : 'Service Unavailable',
      body: '{"error":{"code":"NOT_FOUND"}}',
      statusCode: status,
      responseBody: '{"error":{"code":"NOT_FOUND"}}',
      errorSource: 'FetchHttpError',
    },
  );
}
