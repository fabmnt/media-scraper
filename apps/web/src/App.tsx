import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './api';
import { queryKeys } from './query-keys';
import { AccessGate } from './components/AccessGate';
import { Dashboard } from './components/Dashboard';
import { LandingPage } from './components/LandingPage';

function DashboardRoute() {
  const session = useQuery({
    queryKey: queryKeys.session,
    queryFn: api.getSession,
    retry: false,
  });

  if (session.isLoading) {
    return <p className="empty-state page-loading">Loading archive…</p>;
  }
  if (session.error) {
    if (session.error instanceof ApiError && session.error.status === 401) {
      return <AccessGate />;
    }

    return (
      <main className="access-gate">
        <p className="error" role="alert">
          Could not verify your session. {session.error.message}
        </p>
        <button onClick={() => void session.refetch()} type="button">
          Try again
        </button>
      </main>
    );
  }
  if (!session.data) return null;

  return <Dashboard />;
}

export function App() {
  const isDashboard = window.location.pathname.startsWith('/dashboard');

  return isDashboard ? <DashboardRoute /> : <LandingPage />;
}
