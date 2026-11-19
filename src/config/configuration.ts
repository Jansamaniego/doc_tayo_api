import { registerAs } from '@nestjs/config';
import { parseEnv } from './env.validation.js';

/**
 * Namespaced, typed configuration. These factories (and `validate` below) are
 * the only code allowed to read the process environment.
 */
// Validation happens when each namespace is first built (at module
// initialisation), so invalid input aborts startup before the app serves traffic.
const read = () => parseEnv(process.env);

export const appConfig = registerAs('app', () => read().app);
export const databaseConfig = registerAs('database', () => read().database);
export const corsConfig = registerAs('cors', () => read().cors);
export const loggingConfig = registerAs('logging', () => read().logging);
export const swaggerConfig = registerAs('swagger', () => read().swagger);
export const observeConfig = registerAs('observe', () => read().observe);
export const authConfig = registerAs('auth', () => read().auth);
export const mailConfig = registerAs('mail', () => read().mail);

export const configNamespaces = [
  appConfig,
  databaseConfig,
  corsConfig,
  loggingConfig,
  swaggerConfig,
  observeConfig,
  authConfig,
  mailConfig,
];
