// Seeds a development clinic so you can sign in right away.
//
//   npm run db:seed:dev          (builds first, reads .env)
//
// Uses the app's own runtime role (DATABASE_URL). Refuses to run when
// NODE_ENV=production. Safe to run repeatedly.
import { NestFactory } from '@nestjs/core';

const { AppModule } = await import('../../dist/app.module.js');
const { DEV_SEED, seedDev } = await import('../../dist/dev/seed.js');

const app = await NestFactory.createApplicationContext(AppModule, {
  logger: ['error', 'warn'],
});
try {
  const result = await seedDev(app);
  const lines = [
    result.created
      ? 'Created the development clinic.'
      : 'The development clinic already existed (nothing duplicated).',
    '',
    `  Clinic:        ${DEV_SEED.clinicName}`,
    `  Owner:         ${DEV_SEED.ownerEmail}`,
    `  Receptionist:  ${DEV_SEED.receptionistEmail}  (read-only role)`,
    `  Password:      ${DEV_SEED.password}`,
    '',
    'These accounts exist only on the database you just seeded.',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
} finally {
  await app.close();
}
