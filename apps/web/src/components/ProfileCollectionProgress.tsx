import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { queryKeys } from '../query-keys';

const PROGRESS_REFETCH_MS = 10_000;
const CIRCLE_RADIUS = 36;
const CIRCLE_CIRCUMFERENCE = 2 * Math.PI * CIRCLE_RADIUS;

function collectionProgress(counts: {
  completed: number;
  failed: number;
  processing: number;
  queued: number;
}) {
  const total =
    counts.queued + counts.processing + counts.completed + counts.failed;
  const finished = counts.completed + counts.failed;
  const percentage = total === 0 ? 0 : Math.round((finished / total) * 100);

  return { finished, percentage, total };
}

export function ProfileCollectionProgress() {
  const progress = useQuery({
    queryKey: queryKeys.profileCollectionProgress,
    queryFn: api.listProfileCollectionProgress,
    refetchInterval: PROGRESS_REFETCH_MS,
  });

  if (progress.isLoading || progress.data?.length === 0) return null;
  if (progress.error) {
    return <p className="error">Could not load collection progress.</p>;
  }

  return (
    <section
      aria-labelledby="profile-collection-progress-title"
      className="profile-collection-progress"
    >
      <div className="section-heading">
        <div>
          <span className="eyebrow">COLLECTION PROGRESS</span>
          <h2 id="profile-collection-progress-title">
            Profiles being collected
          </h2>
        </div>
      </div>
      <div className="profile-collection-progress-list">
        {progress.data?.map((item) => {
          const { finished, percentage, total } = collectionProgress(
            item.collections,
          );
          const dashOffset = CIRCLE_CIRCUMFERENCE * (1 - percentage / 100);
          const isDiscovering = total === 0;
          const failureMessage =
            item.collections.failed > 0
              ? `${String(item.collections.failed)} failed`
              : undefined;

          return (
            <article
              className="profile-collection-progress-item"
              key={item.profile.id}
            >
              <div
                aria-label={`Collection progress for @${item.profile.username}: ${String(percentage)}%`}
                className="collection-progress-circle"
                role="progressbar"
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={percentage}
              >
                <svg aria-hidden="true" viewBox="0 0 88 88">
                  <circle
                    className="collection-progress-track"
                    cx="44"
                    cy="44"
                    r={CIRCLE_RADIUS}
                  />
                  <circle
                    className="collection-progress-value"
                    cx="44"
                    cy="44"
                    r={CIRCLE_RADIUS}
                    strokeDasharray={CIRCLE_CIRCUMFERENCE}
                    strokeDashoffset={dashOffset}
                  />
                </svg>
                <strong>{String(percentage)}%</strong>
              </div>
              <div className="profile-collection-progress-copy">
                <span className={`status status-${item.backfill.status}`}>
                  {isDiscovering ? 'discovering' : item.backfill.status}
                </span>
                <strong>
                  {item.profile.platform} · @{item.profile.username}
                </strong>
                <small>
                  {isDiscovering
                    ? `${String(item.backfill.itemsDiscovered)} media item${item.backfill.itemsDiscovered === 1 ? '' : 's'} discovered`
                    : `${String(finished)} of ${String(total)} collection jobs finished`}
                </small>
                {failureMessage && (
                  <small className="error">{failureMessage}</small>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
