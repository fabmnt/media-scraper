import { CollectionForm } from './components/CollectionForm';
import { Gallery } from './components/Gallery';
import { InstagramCredentials } from './components/InstagramCredentials';
import { JobsPanel } from './components/JobsPanel';

export function App() {
  return (
    <>
      <header>
        <a className="brand" href="/">
          M/S
        </a>
        <span>Personal media archive</span>
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
