const IANA_ZONES: ReadonlySet<string> = new Set([
  ...Intl.supportedValuesOf('timeZone'),
  'UTC',
]);

/** True only for canonical IANA names (e.g. `Asia/Manila`), not offsets or abbreviations. */
export function isValidTimeZone(value: string): boolean {
  return IANA_ZONES.has(value);
}
