import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SUPPORTED_PLATFORMS } from '@media-scraper/shared';
import { api } from '../api';
import { CollectionForm } from './CollectionForm';
import { Gallery } from './Gallery';
import { PlatformCredentials } from './PlatformCredentials';
import { JobsPanel } from './JobsPanel';

const DASHBOARD_TABS = [
  { id: 'authentication', label: 'Authentication' },
  { id: 'collect', label: 'Collect' },
  { id: 'activity', label: 'Activity' },
  { id: 'library', label: 'Media' },
] as const;
type DashboardTab = (typeof DASHBOARD_TABS)[number]['id'];
const DEFAULT_TAB: DashboardTab = 'authentication';

function tabFromHash(): DashboardTab {
  const tab = window.location.hash.slice(1);
  return DASHBOARD_TABS.some((item) => item.id === tab)
    ? (tab as DashboardTab)
    : DEFAULT_TAB;
}

export function Dashboard() {
  const [activeTab, setActiveTab] = useState<DashboardTab>(tabFromHash);
  const queryClient = useQueryClient();
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      queryClient.clear();
      window.location.assign('/');
    },
  });

  useEffect(() => {
    const syncTabWithHash = () => setActiveTab(tabFromHash());
    window.addEventListener('hashchange', syncTabWithHash);
    return () => window.removeEventListener('hashchange', syncTabWithHash);
  }, []);

  function selectTab(tab: DashboardTab) {
    setActiveTab(tab);
    window.history.replaceState(null, '', `#${tab}`);
  }

  return (
    <>
      <header className="site-header dashboard-header">
        <a className="brand" href="/" aria-label="Media Scraper home">
          M/S
        </a>
        <nav aria-label="Dashboard navigation">
          {DASHBOARD_TABS.map((tab) => (
            <a
              aria-current={activeTab === tab.id ? 'page' : undefined}
              href={`#${tab.id}`}
              key={tab.id}
              onClick={(event) => {
                event.preventDefault();
                selectTab(tab.id);
              }}
            >
              {tab.label}
            </a>
          ))}
        </nav>
        <button
          className="text-button"
          disabled={logout.isPending}
          onClick={() => logout.mutate()}
          type="button"
        >
          Sign out
        </button>
        {logout.error && (
          <p className="error" role="alert">
            Could not sign out. {logout.error.message}
          </p>
        )}
      </header>
      <main className="dashboard-main">
        <section className="dashboard-intro">
          <div>
            <span className="eyebrow">DASHBOARD / ARCHIVE</span>
            <h1>Your collection.</h1>
          </div>
          <p>
            Collect new media, follow scraping activity, and organize everything
            you have saved.
          </p>
        </section>

        <div
          aria-label="Dashboard sections"
          className="dashboard-tabs"
          role="tablist"
        >
          {DASHBOARD_TABS.map((tab, index) => (
            <button
              aria-controls={`${tab.id}-panel`}
              aria-selected={activeTab === tab.id}
              className={activeTab === tab.id ? 'active' : ''}
              id={`${tab.id}-tab`}
              key={tab.id}
              onClick={() => selectTab(tab.id)}
              role="tab"
              type="button"
            >
              <span>0{index + 1}</span>
              {tab.label}
            </button>
          ))}
        </div>

        <section
          aria-labelledby={`${activeTab}-tab`}
          className="dashboard-tab-panel"
          id={`${activeTab}-panel`}
          role="tabpanel"
        >
          {activeTab === 'authentication' &&
            SUPPORTED_PLATFORMS.map((platform) => (
              <PlatformCredentials key={platform} platform={platform} />
            ))}
          {activeTab === 'collect' && <CollectionForm />}
          {activeTab === 'activity' && <JobsPanel />}
          {activeTab === 'library' && <Gallery />}
        </section>
      </main>
      <footer>
        <span>Media Scraper dashboard</span>
        <span>Preserve attribution and source links.</span>
      </footer>
    </>
  );
}
