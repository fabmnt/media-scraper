import { defineConfig } from 'tsup';

export default defineConfig({
  clean: true,
  entry: ['src/index.ts', 'src/migrate-storage.ts'],
  format: ['esm'],
  noExternal: [/^@media-scraper\//],
});
