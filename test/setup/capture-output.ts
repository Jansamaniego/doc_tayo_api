import { vi } from 'vitest';

/** Captures everything written to stdout/stderr (where the Nest logger writes). */
export function captureOutput() {
  const chunks: string[] = [];
  const record = (chunk: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };
  const out = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(record as never);
  const err = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(record as never);
  return {
    text: () => chunks.join(''),
    restore: () => {
      out.mockRestore();
      err.mockRestore();
    },
  };
}
