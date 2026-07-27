// T006 — config mínima do vitest para os módulos puros de src/shared
// (ver plan.md: "TDD com escopo" — CommandBuilder/SessionIndexer/perfis).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
