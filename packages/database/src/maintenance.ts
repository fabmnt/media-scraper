import { sql } from 'drizzle-orm';
import type { MediaMaintenanceType } from '@media-scraper/shared';
import { mediaMaintenanceTasks } from './schema.js';
import type { Database } from './index.js';

const RETENTION_TASK_TARGET = 'global';

interface AssetLocation {
  relativePath: string | null;
  storageKey: string | null;
}

interface MaintenanceTaskValue {
  target: string;
  type: MediaMaintenanceType;
}

export function cleanupTasksForAssets(
  assets: readonly AssetLocation[],
): MaintenanceTaskValue[] {
  return assets.flatMap((asset): MaintenanceTaskValue[] => {
    if (asset.relativePath) {
      return [{ target: asset.relativePath, type: 'delete_local' as const }];
    }
    return asset.storageKey
      ? [{ target: asset.storageKey, type: 'delete_object' as const }]
      : [];
  });
}

export async function enqueueRetention(db: Pick<Database, 'insert'>) {
  await db
    .insert(mediaMaintenanceTasks)
    .values({ target: RETENTION_TASK_TARGET, type: 'enforce_retention' })
    .onConflictDoUpdate({
      target: [mediaMaintenanceTasks.type, mediaMaintenanceTasks.target],
      set: {
        attempts: 0,
        availableAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
        version: sql`${mediaMaintenanceTasks.version} + 1`,
      },
    });
}

export async function enqueueAssetCleanup(
  db: Pick<Database, 'insert'>,
  assets: readonly AssetLocation[],
) {
  const tasks = cleanupTasksForAssets(assets);
  if (tasks.length === 0) return;
  await db
    .insert(mediaMaintenanceTasks)
    .values(tasks)
    .onConflictDoUpdate({
      target: [mediaMaintenanceTasks.type, mediaMaintenanceTasks.target],
      set: {
        attempts: 0,
        availableAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
        version: sql`${mediaMaintenanceTasks.version} + 1`,
      },
    });
}
