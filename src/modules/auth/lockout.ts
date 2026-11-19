/** Consecutive failed logins before the account locks (plans/02 §9.2). */
export const LOCKOUT_THRESHOLD = 10;
/** Lock length. It expires on its own, which limits lockout-as-denial-of-service. */
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
