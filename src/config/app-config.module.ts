import { ConfigModule } from '@nestjs/config';
import { configNamespaces } from './configuration.js';

/**
 * Global, validated configuration. Invalid configuration aborts
 * startup (see parseEnv).
 */
export const AppConfigModule = ConfigModule.forRoot({
  isGlobal: true,
  cache: true,
  // Production uses real environment variables only; tests load .env.test
  // themselves (test/setup/load-env.ts).
  ignoreEnvFile: ['production', 'test'].includes(process.env.NODE_ENV ?? ''),
  load: configNamespaces,
});
