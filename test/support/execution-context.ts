import type { ExecutionContext, Type } from '@nestjs/common';

/** Minimal ExecutionContext for guard unit tests. */
export function executionContextFor(
  controller: Type<unknown>,
  method: string,
  request: unknown = {},
): ExecutionContext {
  return {
    getHandler: () =>
      (controller.prototype as Record<string, () => unknown>)[method],
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}
