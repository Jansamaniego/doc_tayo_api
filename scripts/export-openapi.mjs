// Writes the API contract to docs/openapi.json (the file to hand to the
// frontend). Run it after any change to endpoints, DTOs or error documentation:
//
//   npm run openapi:export
//
// The app is created but never initialised, so no database connection is made.
// A test fails when the committed file is out of date.
import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';

const { AppModule } = await import('../dist/app.module.js');
const { applyAppSetup, buildOpenApiDocument } =
  await import('../dist/app.setup.js');

const app = await NestFactory.create(AppModule, { logger: false });
try {
  applyAppSetup(app);
  const document = buildOpenApiDocument(app);
  writeFileSync('docs/openapi.json', `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(
    `Wrote docs/openapi.json (${Object.keys(document.paths).length} paths)\n`,
  );
} finally {
  await app.close();
}
