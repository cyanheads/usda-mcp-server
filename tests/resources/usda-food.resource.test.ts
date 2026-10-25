/**
 * @fileoverview Tests for usda_food resource (usda://food/{fdcId}).
 * @module tests/resources/usda-food.resource.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, type FetchMockHarness } from '@cyanheads/mcp-ts-core/testing';
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usdaFoodResource } from '@/mcp-server/resources/definitions/usda-food.resource.js';
import { createFdcFake } from '../fdc-fake.js';

const { params: foodParams } = usdaFoodResource;
if (!foodParams) throw new Error('usda://food/{fdcId} must declare params');

/**
 * The McpError `fetchWithTimeout` throws for a non-2xx FDC response: the
 * status-mapped code, plus `status` and its legacy `statusCode` alias.
 */
function fdcHttpError(status: number, message: string): McpError {
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

const PROTOCOL_VERSION = '2026-07-28';

/**
 * Reads `uri` through the framework's resource handler factory and returns the
 * JSON-RPC `error` a client receives — the path that fills the declared
 * recovery hint, which a direct `handler(...)` call never does.
 */
async function readResourceError(uri: string): Promise<{
  code: number;
  message: string;
  data: Record<string, unknown>;
}> {
  // Worker initialization writes these; restored by the caller's `vi.unstubAllEnvs()`.
  vi.stubEnv('IS_SERVERLESS', undefined);
  vi.stubEnv('MCP_TRANSPORT_TYPE', undefined);
  vi.stubEnv('MCP_LOG_LEVEL', undefined);
  const worker = createWorkerHandler({ name: 'usda-mcp-server', resources: [usdaFoodResource] });
  const response = await worker.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Method': 'resources/read',
        'Mcp-Name': uri,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: {
          uri,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientInfo': { name: 'usda-food-test', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    }),
    { LOG_LEVEL: 'error' },
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  );
  const text = await response.text();
  const body = /^(event|data):/.test(text)
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n')
    : text;
  const message = JSON.parse(body) as { error?: Awaited<ReturnType<typeof readResourceError>> };
  if (!message.error) throw new Error(`resources/read did not fail: ${text}`);
  return message.error;
}

let http: FetchMockHarness;

vi.mock('@/services/fdc/fdc-service.js', () => {
  const mockService = {
    getFoodDetail: vi.fn(),
  };
  return {
    FdcService: vi.fn(() => mockService),
    getFdcService: vi.fn(() => mockService),
    initFdcService: vi.fn(),
  };
});

async function getServiceMock() {
  const { getFdcService } = await import('@/services/fdc/fdc-service.js');
  return getFdcService() as unknown as { getFoodDetail: ReturnType<typeof vi.fn> };
}

const MOCK_FOOD_DETAIL = {
  fdcId: 171077,
  description: 'Chicken breast raw',
  dataType: 'SR Legacy',
  nutrients: [{ id: 1003, name: 'Protein', number: '203', amount: 22.5, unit: 'G' }],
  portions: [],
};

describe('usdaFoodResource', () => {
  beforeEach(async () => {
    const service = await getServiceMock();
    service.getFoodDetail.mockClear();
    service.getFoodDetail.mockResolvedValue(MOCK_FOOD_DETAIL);
  });

  it('declares no cache hint — it proxies live FDC records', () => {
    // Deliberate: a TTL here would let a client serve a stale profile for a
    // food USDA has since revised. Only the bundled nutrient table is cacheable.
    expect(usdaFoodResource.cacheHint).toBeUndefined();
  });

  it('returns food detail for a valid FDC ID', async () => {
    const service = await getServiceMock();
    const ctx = createMockContext({ errors: usdaFoodResource.errors });
    const params = foodParams.parse({ fdcId: '171077' });
    const result = await usdaFoodResource.handler(params, ctx);

    expect(result).toMatchObject({
      fdcId: 171077,
      description: 'Chicken breast raw',
    });
    expect(service.getFoodDetail).toHaveBeenCalledWith(171077, undefined, ctx);
  });

  it('accepts a single-digit FDC ID', async () => {
    const service = await getServiceMock();
    const ctx = createMockContext({ errors: usdaFoodResource.errors });
    const params = foodParams.parse({ fdcId: '1' });
    await usdaFoodResource.handler(params, ctx);

    expect(service.getFoodDetail).toHaveBeenCalledWith(1, undefined, ctx);
  });

  it.each([
    ['non-numeric', 'abc'],
    ['zero', '0'],
    ['negative', '-5'],
    ['empty string', ''],
    ['trailing characters', '171077abc'],
    ['a decimal', '171077.5'],
    ['exponent notation', '1e5'],
    ['a leading zero', '0171077'],
    ['a leading sign', '+171077'],
    ['leading whitespace', ' 171077'],
    ['trailing whitespace', '171077 '],
  ])('throws ctx.fail("invalid_id") for %s', async (_label, fdcId) => {
    const service = await getServiceMock();
    const ctx = createMockContext({ errors: usdaFoodResource.errors });
    const params = foodParams.parse({ fdcId });

    await expect(usdaFoodResource.handler(params, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id' },
    });
    // A coerced ID would have fetched some other food and returned it as this one.
    expect(service.getFoodDetail).not.toHaveBeenCalled();
  });

  it('throws ctx.fail("not_found") when the service throws its HTTP 404 McpError', async () => {
    const service = await getServiceMock();
    const upstream = fdcHttpError(
      404,
      'Fetch failed for https://api.example/food/999999. Status: 404',
    );
    service.getFoodDetail.mockRejectedValue(upstream);
    const ctx = createMockContext({ errors: usdaFoodResource.errors });
    const params = foodParams.parse({ fdcId: '999999' });

    const err = await Promise.resolve(usdaFoodResource.handler(params, ctx)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: 'FDC ID 999999 not found.',
      data: { reason: 'not_found', fdcId: 999999 },
    });
    // The upstream error rides as cause for the server log, never in data
    expect((err as McpError).cause).toBe(upstream);
    expect((err as McpError).data).not.toHaveProperty('status');
  });

  /**
   * not_found is decided by the structured status the service's HTTP error
   * carries, never by message wording.
   */
  describe('not_found classification', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('maps a status-404 McpError whose message never says 404 or not found', async () => {
      const service = await getServiceMock();
      service.getFoodDetail.mockRejectedValue(fdcHttpError(404, 'No such food'));

      const error = await readResourceError('usda://food/1');

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        message: 'FDC ID 1 not found.',
        data: {
          reason: 'not_found',
          recovery: {
            hint: 'Verify the FDC ID using usda_search_foods and use a valid numeric ID.',
          },
        },
      });
    });

    it.each([
      ['a plain Error saying "404 Not Found"', new Error('404 Not Found')],
      [
        'a non-404 HTTP McpError saying "404" and "not found"',
        fdcHttpError(503, 'Proxy says 404: upstream route not found'),
      ],
    ])('propagates %s unchanged', async (_label, upstream) => {
      const service = await getServiceMock();
      service.getFoodDetail.mockRejectedValue(upstream);
      const ctx = createMockContext({ errors: usdaFoodResource.errors });

      await expect(usdaFoodResource.handler(foodParams.parse({ fdcId: '1' }), ctx)).rejects.toBe(
        upstream,
      );
    });
  });

  describe('not_found over the real FdcService', () => {
    beforeEach(async () => {
      vi.stubEnv('USDA_FDC_API_KEY', 'test-key');
      http = createFdcFake();
      http.install();
      const actual = await vi.importActual<typeof import('@/services/fdc/fdc-service.js')>(
        '@/services/fdc/fdc-service.js',
      );
      const real = new actual.FdcService();
      const service = await getServiceMock();
      service.getFoodDetail.mockImplementation(real.getFoodDetail.bind(real));
    });

    afterEach(() => {
      http.restore();
      vi.unstubAllEnvs();
    });

    it('fails not_found for an FDC 404', async () => {
      const ctx = createMockContext({ errors: usdaFoodResource.errors });

      await expect(
        usdaFoodResource.handler(foodParams.parse({ fdcId: '999999999' }), ctx),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'not_found', fdcId: 999999999 },
      });
      expect(http.calls.map((c) => new URL(c.request.url).pathname)).toEqual([
        '/fdc/v1/food/999999999',
      ]);
    });
  });

  it('propagates non-404 service errors', async () => {
    const service = await getServiceMock();
    service.getFoodDetail.mockRejectedValue(new Error('Service unavailable'));
    const ctx = createMockContext({ errors: usdaFoodResource.errors });
    const params = foodParams.parse({ fdcId: '171077' });

    await expect(usdaFoodResource.handler(params, ctx)).rejects.toThrow('Service unavailable');
  });

  it('handles sparse upstream payload with no optional fields', async () => {
    const service = await getServiceMock();
    service.getFoodDetail.mockResolvedValue({
      fdcId: 1,
      description: 'Sparse food',
      dataType: 'SR Legacy',
      nutrients: [],
      portions: [],
    });
    const ctx = createMockContext({ errors: usdaFoodResource.errors });
    const params = foodParams.parse({ fdcId: '1' });
    const result = await usdaFoodResource.handler(params, ctx);

    expect(result).toBeDefined();
    expect((result as { fdcId: number }).fdcId).toBe(1);
  });
});
