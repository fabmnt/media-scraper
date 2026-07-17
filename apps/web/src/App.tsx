import { useQuery } from '@tanstack/react-query';
import { api } from './api';
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
  if (!session.data) return <AccessGate />;

  return <Dashboard />;
}

export function App() {
  const isDashboard = window.location.pathname.startsWith('/dashboard');

  return isDashboard ? <DashboardRoute /> : <LandingPage />;
}
