import './style.css';
import { renderLanding } from './landing';
import { renderWall } from './wall';
import { LocalStorageBackend, setBackend } from './storage';
import { createSpacetimeBackend } from './spacetime';

// Shared realtime wall via SpacetimeDB when the env points at a database;
// otherwise fall back to a local-only wall (seeded, single browser).
const dbUri = import.meta.env.VITE_SPACETIMEDB_URI as string | undefined;
const dbName = import.meta.env.VITE_SPACETIMEDB_DB as string | undefined;

const backend = dbUri && dbName
  ? createSpacetimeBackend(dbUri, dbName)
  : new LocalStorageBackend();
setBackend(backend);
backend.start();

const app = document.getElementById('app')!;

function parseHash(): { view: 'landing' | 'wall'; explore: boolean; deepLink?: string; place?: string } {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [path, queryStr] = hash.split('?');
  const params = new URLSearchParams(queryStr || '');

  if (path === 'wall' || path === 'w') {
    const deepLink = params.get('id') || undefined;
    return { view: 'wall', explore: params.get('explore') === 'true', deepLink, place: params.get('place') || undefined };
  }
  return { view: 'landing', explore: false };
}

function render(): void {
  const route = parseHash();
  app.innerHTML = '';

  if (route.view === 'wall') {
    renderWall(app, { explore: route.explore, deepLink: route.deepLink, place: route.place });
  } else {
    renderLanding(app);
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);
render();
