import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { queryKeys } from '../query-keys';

export function JobsPanel() {
  const queryClient = useQueryClient();
  const { data = [] } = useQuery({
    queryKey: queryKeys.collections,
    queryFn: api.listCollections,
    refetchInterval: 3_000,
  });
  const retry = useMutation({
    mutationFn: api.retryCollection,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.collections });
    },
  });
  const recentJobs = data.slice(0, 5);

  if (recentJobs.length === 0) return null;

  return (
    <section className="jobs">
      <div className="section-heading">
        <div>
          <span className="eyebrow">ACTIVITY</span>
          <h2>Recent collections</h2>
        </div>
      </div>
      <div className="job-list">
        {recentJobs.map((job) => (
          <article className="job" key={job.id}>
            <span className={`status status-${job.status}`}>{job.status}</span>
            <div>
              <strong>{job.platform}</strong>
              <a href={job.sourceUrl} rel="noreferrer" target="_blank">
                {job.sourceUrl}
              </a>
              {job.errorMessage && <small>{job.errorMessage}</small>}
            </div>
            {job.status === 'failed' && (
              <button onClick={() => retry.mutate(job.id)} type="button">
                Retry
              </button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
