import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { defineConfig } from 'vitest/config';

// On Windows the shell cwd drive-letter casing (e.g. `c:\`) can differ from the
// path vitest's runner registers suites under (`C:/...`), which makes the
// collector report "No test suite found" despite the transform running fine.
// Deriving an explicit normalized root from this config file's own location
// keeps discovery and collection keyed on the same casing.
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  test: {
    root,
    include: ['src/**/*.test.ts'],
  },
});
