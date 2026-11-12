@AGENTS.md

## Operating Principles (Non-Negotiable)

     1. **Correctness over cleverness**: Prefer boring, readable solutions.
     2. **Smallest change that works**: Don't refactor adjacent code unless necessary.
     3. **Follow existing patterns**: Check `src/` structure before introducing new abstractions.
     4. **Be explicit about uncertainty**: If something cannot be verified, say so.
     5. **Todo list is mandatory for every task**: At the START of every task (before any code is read or written), create a todo list using `TaskCreate` that maps to the
     Task Lifecycle steps. This is not optional. The todo list is what prevents early stopping and missed steps.

## Mandatory Development Rule: Tests First

**Tests must ALWAYS be written before implementation code. This is a mandatory development rule, not an optional recommendation.**

Before writing or modifying any feature or bug-fix implementation:

1. Understand the requirement and inspect the existing implementation.
2. Identify the expected behavior, edge cases, and failure scenarios.
3. Write the tests that define and verify the expected behavior.
4. Run the tests and confirm that they fail for the expected reason (or otherwise demonstrate that the new behavior is not yet implemented).
5. Only then write or modify implementation code.
6. Run the relevant tests again and confirm they pass.
7. Run the broader relevant test suite to detect regressions.

**If you catch yourself writing implementation code before its tests, STOP. Write the tests first, then continue.**

### Testing requirements

- Apply this rule to backend and frontend development.
- Backend: follow the testing conventions and directory structure defined in the backend `plan.md`. Unit tests should follow the established `*.spec.ts` convention alongside the code they test. E2E tests belong in the designated backend E2E test directory.
- Frontend: follow the frontend plan's testing conventions. E2E tests belong in `tests/e2e/`, unless the approved frontend plan specifies otherwise.
- Use real PostgreSQL for integration and database behavior tests. Do not mock Prisma when verifying actual database behavior.
- Include positive cases, negative cases, validation failures, boundary conditions, and relevant security scenarios.
- For multi-tenant functionality, test cross-tenant access and isolation explicitly.
- For bug fixes, write a regression test that reproduces the bug before fixing it.
- For refactoring, add or verify tests that protect existing behavior before changing implementation.
- Do not weaken, delete, skip, or modify assertions merely to make failing tests pass. Change tests only when requirements or expected behavior legitimately change.
- Never claim a feature is complete merely because the code compiles. Its relevant tests must pass.

### Test execution and reporting

After implementation:

- Run the tests directly related to the change.
- Run the relevant broader test suite.
- Run linting and type checking when applicable.
- Report which tests were added, which commands were executed, and whether they passed.
- Clearly disclose any tests that could not be executed and why.

### Important distinction

Planning tasks do not require implementation tests to be written prematurely. However, every implementation milestone must specify its tests and acceptance criteria before implementation begins.

**Priority:** This rule takes precedence over speed or convenience. Never skip test-first development to save time or tokens.