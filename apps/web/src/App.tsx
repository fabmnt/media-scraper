import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { queryKeys } from './query-keys';
import { AccessGate } from './components/AccessGate';
import { CollectionForm } from './components/CollectionForm';
import { Gallery } from './components/Gallery';
import { InstagramCredentials } from './components/InstagramCredentials';
import { JobsPanel } from './components/JobsPanel';

export function App() {
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: queryKeys.session,
    queryFn: api.getSession,
    retry: false,
  });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      queryClient.clear();
      window.location.reload();
    },
  });

  if (session.isLoading) {
    return <p className="empty-state">Loading archive…</p>;
  }
  if (!session.data) return <AccessGate />;

  return (
    <>
      <header>
        <a className="brand" href="/">
          M/S
        </a>
        <span>Personal media archive</span>
        <button
          className="text-button"
          disabled={logout.isPending}
          onClick={() => logout.mutate()}
          type="button"
        >
          Sign out
        </button>
      </header>
      <main>
        <section className="hero">
          <span className="eyebrow">MEDIA SCRAPER / 001</span>
          <h1>Everything worth keeping, in one place.</h1>
          <p>
            Save public social media without losing it in tabs, bookmarks, or
            feeds.
          </p>
        </section>
        <InstagramCredentials />
        <CollectionForm />
        <JobsPanel />
        <Gallery />
      </main>
      <footer>
        Built for personal archiving. Preserve attribution and source links.
      </footer>
    </>
  );
}
