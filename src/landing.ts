import { formatCount } from './utils';

const PREVIEW_GRAFFITI = [
  { text: 'i was here', x: '12%', y: '18%', color: '#ff4d4d', size: '16px', rotate: -3 },
  { text: '☻', x: '8%', y: '45%', color: '#4ecdc4', size: '28px', rotate: 5 },
  { text: '★★★', x: '22%', y: '30%', color: '#ffeaa7', size: '18px', rotate: 0 },
  { text: '[alex]', x: '18%', y: '52%', color: '#85c1e9', size: '12px', rotate: 2 },
  { text: '"don\'t delete this"', x: '40%', y: '22%', color: '#bb8fce', size: '13px', rotate: -1 },
  { text: '┌─────────┐', x: '55%', y: '35%', color: '#555', size: '11px', rotate: 0 },
  { text: '│ DRAW │', x: '58%', y: '42%', color: '#555', size: '11px', rotate: 0 },
  { text: '└─────────┘', x: '55%', y: '49%', color: '#555', size: '11px', rotate: 0 },
  { text: '🐸', x: '75%', y: '25%', color: '#fff', size: '22px', rotate: 8 },
  { text: 'lol', x: '80%', y: '40%', color: '#f8c471', size: '14px', rotate: -4 },
  { text: '<3', x: '68%', y: '60%', color: '#ff4d4d', size: '16px', rotate: 3 },
  { text: '🚀', x: '85%', y: '55%', color: '#fff', size: '20px', rotate: -6 },
  { text: 'the void stares back', x: '30%', y: '70%', color: '#444', size: '11px', rotate: 1 },
  { text: '☆', x: '50%', y: '15%', color: '#ffeaa7', size: '20px', rotate: 12 },
  { text: 'BRB', x: '90%', y: '30%', color: '#4ecdc4', size: '14px', rotate: -2 },
  { text: 'you matter :)', x: '35%', y: '55%', color: '#82e0aa', size: '13px', rotate: 0 },
  { text: '░▒▓█', x: '15%', y: '75%', color: '#666', size: '14px', rotate: 5 },
  { text: '████', x: '60%', y: '72%', color: '#ff4d4d', size: '10px', rotate: 0 },
  { text: '████', x: '62%', y: '75%', color: '#4ecdc4', size: '10px', rotate: 0 },
  { text: '████', x: '64%', y: '78%', color: '#ffeaa7', size: '10px', rotate: 0 },
];

const NOTIFICATIONS = [
  '@mike just painted here',
  'someone left a message 12 seconds ago',
  '@sarah saved this forever',
  'new graffiti nearby',
  '@voidwalker left a secret',
  'someone drew a cat at 42,000, 8,000',
  '@pixel found something weird',
  'a time capsule just opened',
];

interface Stats {
  marksLeft: number;
  visitorsToday: number;
  disappeared: number;
  kept: number;
}

function animateNumber(el: HTMLElement, target: number, duration: number = 2000): void {
  const start = 0;
  const startTime = performance.now();

  function tick(now: number) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.floor(start + (target - start) * eased);
    el.textContent = formatCount(current);
    if (progress < 1) requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

export function renderLanding(container: HTMLElement): void {
  const stats: Stats = {
    marksLeft: 18391,
    visitorsToday: 4821,
    disappeared: 12843,
    kept: 2190,
  };

  container.innerHTML = `
    <div class="landing">
      <nav class="landing-nav">
        <div class="landing-logo">thewall</div>
        <div class="landing-nav-links">
          <a href="#/wall">Enter</a>
          <a href="#/wall?explore=true">Explore</a>
        </div>
      </nav>

      <section class="hero">
        <div class="hero-content">
          <h1>Leave something on<br>the <span class="accent">internet.</span></h1>
          <p>Draw it. Write it. Mess with it. Keep it forever.</p>
          <div class="hero-ctas">
            <a href="#/wall" class="btn-primary">Enter the wall →</a>
            <a href="#/wall?explore=true" class="btn-secondary">See what people left</a>
          </div>
        </div>
      </section>

      <section class="live-preview-section">
        <div class="live-preview-label">● live from the wall</div>
        <div class="live-preview-container">
          <div class="live-preview-canvas" id="preview-canvas">
            ${PREVIEW_GRAFFITI.map(g => `
              <div class="preview-graffiti" style="
                left: ${g.x};
                top: ${g.y};
                color: ${g.color};
                font-size: ${g.size};
                transform: rotate(${g.rotate}deg);
              ">${g.text}</div>
            `).join('')}
          </div>
          <div class="preview-notification">${NOTIFICATIONS[0]}</div>
          <div class="preview-notification">${NOTIFICATIONS[1]}</div>
          <div class="preview-notification">${NOTIFICATIONS[2]}</div>
        </div>
      </section>

      <section class="stats-section">
        <div class="stats-grid">
          <div class="stat-item">
            <div class="stat-number" id="stat-marks">0</div>
            <div class="stat-label">marks left</div>
          </div>
          <div class="stat-item">
            <div class="stat-number" id="stat-visitors">0</div>
            <div class="stat-label">people visited today</div>
          </div>
          <div class="stat-item">
            <div class="stat-number" id="stat-disappeared">0</div>
            <div class="stat-label">things disappeared forever</div>
          </div>
          <div class="stat-item">
            <div class="stat-number" id="stat-kept">0</div>
            <div class="stat-label">things were kept</div>
          </div>
        </div>
      </section>

      <footer class="landing-footer">
        <p>someone built a giant piece of the internet and forgot to put rules on it</p>
      </footer>
    </div>
  `;

  // Animate stats
  setTimeout(() => {
    const marksEl = document.getElementById('stat-marks');
    const visitorsEl = document.getElementById('stat-visitors');
    const disappearedEl = document.getElementById('stat-disappeared');
    const keptEl = document.getElementById('stat-kept');

    if (marksEl) animateNumber(marksEl, stats.marksLeft);
    if (visitorsEl) animateNumber(visitorsEl, stats.visitorsToday);
    if (disappearedEl) animateNumber(disappearedEl, stats.disappeared);
    if (keptEl) animateNumber(keptEl, stats.kept);
  }, 500);

  // Cycle notifications
  let notifIdx = 0;
  setInterval(() => {
    const notifs = container.querySelectorAll('.preview-notification');
    notifIdx = (notifIdx + 1) % NOTIFICATIONS.length;
    notifs.forEach((el, i) => {
      const idx = (notifIdx + i) % NOTIFICATIONS.length;
      (el as HTMLElement).textContent = NOTIFICATIONS[idx];
    });
  }, 4000);

  // Subtle movement on preview graffiti
  setInterval(() => {
    const items = container.querySelectorAll('.preview-graffiti');
    items.forEach(item => {
      const el = item as HTMLElement;
      const dx = (Math.random() - 0.5) * 2;
      const dy = (Math.random() - 0.5) * 2;
      const currentTransform = el.style.transform || '';
      const rotateMatch = currentTransform.match(/rotate\(([-\d.]+)deg\)/);
      const rotate = rotateMatch ? parseFloat(rotateMatch[1]) : 0;
      el.style.transform = `translate(${dx}px, ${dy}px) rotate(${rotate + (Math.random() - 0.5) * 0.5}deg)`;
    });
  }, 3000);
}
