import { defineConfig } from 'tsup';

export default defineConfig({
  clean: true,
  entry: [
    'src/backfill-thumbnails.ts',
    'src/index.ts',
    'src/migrate-storage.ts',
  ],
  format: ['esm'],
  noExternal: [/^@media-scraper\//],
});
