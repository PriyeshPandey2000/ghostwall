import './style.css';
import { renderLanding } from './landing';
import { renderWall } from './wall';
import { setBackend } from './storage';
import { createSpacetimeBackend } from './spacetime';

const backend = createSpacetimeBackend('wss://maincloud.spacetimedb.com', 'ghostwall');
setBackend(backend);
backend.start();

const app = document.getElementById('app')!;

function parseHash(): { view: 'landing' | 'wall'; explore: boolean; deepLink?: string } {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [path, queryStr] = hash.split('?');
  const params = new URLSearchParams(queryStr || '');

  if (path === 'wall' || path === 'w') {
    const deepLink = params.get('id') || undefined;
    return { view: 'wall', explore: params.get('explore') === 'true', deepLink };
  }
  return { view: 'landing', explore: false };
}

function render(): void {
  const route = parseHash();
  app.innerHTML = '';

  if (route.view === 'wall') {
    renderWall(app, { explore: route.explore, deepLink: route.deepLink });
  } else {
    renderLanding(app);
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);
render();
