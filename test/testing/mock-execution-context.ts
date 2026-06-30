import type { ExecutionContext } from '@nestjs/common';
import { vi } from 'vitest';

export interface MockHttpContext {
  request: Record<string, unknown>;
  response: {
    setHeader: ReturnType<typeof vi.fn>;
  };
}

/**
 * Creates a minimal NestJS HTTP ExecutionContext suitable for unit tests.
 *
 * Stubs only the methods actually consumed by WeightedRateLimiterGuard and
 * WeightedRateLimiterService — avoids a dependency on @nestjs/testing for
 * tests that don't need a full module compilation.
 *
 * @param handler    - Route handler function. Use a named function to verify
 *                     that reportError receives the correct handler name.
 * @param controller - Controller class used by Reflector.getAllAndOverride.
 * @param request    - Partial Express-like request (headers, body, etc.).
 */
export function createMockExecutionContext(
  handler: (...args: unknown[]) => unknown = function testHandler() {},
  controller: new (...args: unknown[]) => unknown = class TestController {},
  request: Record<string, unknown> = {},
): { ctx: ExecutionContext; mock: MockHttpContext } {
  const mock: MockHttpContext = {
    request: { headers: {}, ...request },
    response: { setHeader: vi.fn() },
  };

  const ctx = {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({
      getRequest: <T>() => mock.request as T,
      getResponse: <T>() => mock.response as T,
    }),
    // Stub unused context methods so TypeScript is satisfied
    getArgs: () => [],
    getArgByIndex: () => undefined,
    switchToRpc: () => {
      throw new Error('not HTTP');
    },
    switchToWs: () => {
      throw new Error('not HTTP');
    },
  } as unknown as ExecutionContext;

  return { ctx, mock };
}
