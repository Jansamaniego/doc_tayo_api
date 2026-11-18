import { Transform } from 'class-transformer';

/** Trims surrounding whitespace from string input; other values pass through. */
export const Trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );
