const FEATURES = [
  {
    number: '01',
    title: 'Collect in seconds',
    description:
      'Paste a public post URL and let your archive preserve the media and its source.',
  },
  {
    number: '02',
    title: 'Keep the context',
    description:
      'Captions, creators, platforms, and original links stay attached to every item.',
  },
  {
    number: '03',
    title: 'Find anything again',
    description:
      'Search a compact library or group it by creator and platform as it grows.',
  },
] as const;

export function LandingPage() {
  return (
    <>
      <header className="site-header">
        <a className="brand" href="/" aria-label="Media Scraper home">
          M/S
        </a>
        <span className="header-label">Personal media archive</span>
        <a className="header-link" href="/dashboard">
          Open dashboard <span aria-hidden="true">↗</span>
        </a>
      </header>
      <main>
        <section className="landing-hero">
          <span className="eyebrow">MEDIA SCRAPER / PERSONAL ARCHIVE</span>
          <h1>Everything worth keeping, in one place.</h1>
          <div className="hero-footer">
            <p>
              Save public social media without losing it in tabs, bookmarks, or
              endless feeds.
            </p>
            <a className="primary-link" href="/dashboard">
              Start collecting <span aria-hidden="true">→</span>
            </a>
          </div>
        </section>

        <section className="landing-statement">
          <span className="eyebrow">BUILT FOR OWNERSHIP</span>
          <p>
            Your references deserve more than a bookmark. Build a searchable,
            organized archive that stays with you.
          </p>
        </section>

        <section className="feature-section">
          <div className="section-heading">
            <div>
              <span className="eyebrow">HOW IT WORKS</span>
              <h2>From feed to archive.</h2>
            </div>
            <span className="section-index">001 — 003</span>
          </div>
          <div className="feature-grid">
            {FEATURES.map((feature) => (
              <article className="feature-card" key={feature.number}>
                <span>{feature.number}</span>
                <div>
                  <h3>{feature.title}</h3>
                  <p>{feature.description}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-cta">
          <span className="eyebrow">YOUR MEDIA / YOUR ARCHIVE</span>
          <h2>Ready when you find something worth keeping.</h2>
          <a className="primary-link" href="/dashboard">
            Open your dashboard <span aria-hidden="true">→</span>
          </a>
        </section>
      </main>
      <footer>
        <span>Media Scraper © {new Date().getFullYear()}</span>
        <span>Preserve attribution and source links.</span>
      </footer>
    </>
  );
}
