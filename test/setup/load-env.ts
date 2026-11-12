// Loads .env.test before any test code (and before Nest reads the environment).
// Real environment variables (CI) take priority: loadEnvFile never overrides.
try {
  process.loadEnvFile('.env.test');
} catch {
  // No .env.test: rely on the process environment.
}
