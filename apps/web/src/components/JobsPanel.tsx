import { useEffect, useRef } from 'react';
import { MANUAL_UPLOAD_LABEL } from '@media-scraper/shared';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from '../api';
import { queryKeys } from '../query-keys';

const RECENT_JOB_COUNT = 5;
const FAILED_PAGE_SIZE = 20;
const ACTIVE_JOB_LIMIT = 100;
const ACTIVE_JOB_REFETCH_MS = 10_000;
const IDLE_JOB_REFETCH_MS = 60_000;

export function JobsPanel() {
  const queryClient = useQueryClient();
  const recent = useQuery({
    queryKey: queryKeys.recentCollections,
    queryFn: () => api.listCollections({ limit: RECENT_JOB_COUNT }),
    refetchInterval: (query) =>
      query.state.data?.items.some(
        (job) => job.status === 'queued' || job.status === 'processing',
      )
        ? ACTIVE_JOB_REFETCH_MS
        : IDLE_JOB_REFETCH_MS,
  });
  const queued = useQuery({
    queryKey: queryKeys.activeCollections('queued'),
    queryFn: () =>
      api.listCollections({ limit: ACTIVE_JOB_LIMIT, status: 'queued' }),
    refetchInterval: (query) =>
      query.state.data?.items.length
        ? ACTIVE_JOB_REFETCH_MS
        : IDLE_JOB_REFETCH_MS,
  });
  const processing = useQuery({
    queryKey: queryKeys.activeCollections('processing'),
    queryFn: () =>
      api.listCollections({ limit: ACTIVE_JOB_LIMIT, status: 'processing' }),
    refetchInterval: (query) =>
      query.state.data?.items.length
        ? ACTIVE_JOB_REFETCH_MS
        : IDLE_JOB_REFETCH_MS,
  });
  const failed = useInfiniteQuery({
    queryKey: queryKeys.failedCollections,
    queryFn: ({ pageParam }) =>
      api.listCollections({
        limit: FAILED_PAGE_SIZE,
        offset: pageParam,
        status: 'failed',
      }),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset ?? undefined,
  });
  const previousActiveCount = useRef(0);
  const activeJobs = [
    ...(queued.data?.items ?? []),
    ...(processing.data?.items ?? []),
  ];
  useEffect(() => {
    if (
      recent.data?.items.some((job) => job.status === 'completed') ||
      activeJobs.length < previousActiveCount.current
    ) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.allMedia });
    }
    previousActiveCount.current = activeJobs.length;
  }, [
    activeJobs.length,
    queryClient,
    recent.dataUpdatedAt,
    recent.data?.items,
  ]);

  const retry = useMutation({
    mutationFn: api.retryCollection,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.collections });
    },
  });

  const recentJobs = recent.data?.items ?? [];
  const visibleJobs = [...recentJobs, ...activeJobs];
  const recentIds = new Set(visibleJobs.map((job) => job.id));
  const olderFailures =
    failed.data?.pages
      .flatMap((page) => page.items)
      .filter((job) => !recentIds.has(job.id)) ?? [];
  const jobs = [
    ...new Map(
      [...visibleJobs, ...olderFailures].map((job) => [job.id, job]),
    ).values(),
  ];

  if (
    recent.isLoading ||
    queued.isLoading ||
    processing.isLoading ||
    failed.isLoading
  ) {
    return <p className="empty-state">Loading collection activity…</p>;
  }
  if (recent.error || queued.error || processing.error || failed.error) {
    return (
      <p className="error">
        {
          (recent.error ?? queued.error ?? processing.error ?? failed.error)
            ?.message
        }
      </p>
    );
  }
  if (jobs.length === 0) {
    return <p className="empty-state">No collection activity yet.</p>;
  }

  return (
    <section className="jobs">
      <div className="section-heading">
        <div>
          <span className="eyebrow">ACTIVITY</span>
          <h2>Recent collections and failures</h2>
        </div>
      </div>
      <div className="job-list">
        {jobs.map((job) => (
          <article className="job" key={job.id}>
            <span className={`status status-${job.status}`}>{job.status}</span>
            <div>
              <strong>
                {job.platform === 'manual' ? MANUAL_UPLOAD_LABEL : job.platform}
                {job.origin === 'automatic' ? ' · automatic' : ''}
              </strong>
              {job.sourceUrl ? (
                <a href={job.sourceUrl} rel="noreferrer" target="_blank">
                  {job.sourceUrl}
                </a>
              ) : (
                <span>Uploaded from your device</span>
              )}
              {job.errorMessage && <small>{job.errorMessage}</small>}
            </div>
            {job.status === 'failed' && (
              <button
                disabled={retry.isPending}
                onClick={() => retry.mutate(job.id)}
                type="button"
              >
                Retry
              </button>
            )}
          </article>
        ))}
      </div>
      {retry.error && <p className="error">{retry.error.message}</p>}
      {failed.hasNextPage && (
        <button
          disabled={failed.isFetchingNextPage}
          onClick={() => void failed.fetchNextPage()}
          type="button"
        >
          {failed.isFetchingNextPage ? 'Loading…' : 'Load older failures'}
        </button>
      )}
    </section>
  );
}
