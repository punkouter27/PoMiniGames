// Radzen's script, on demand, for a page that uses Radzen components (Brawl HQ, Leaderboards,
// Profile, Mule, Capitol). The theme stylesheets are linked once, first, in index.html (Po
// standard: Radzen CSS before the app's CSS); ensure() only adds them if that link is missing
// (same ids), and remove() leaves them in place so the theme is never loaded twice or reordered.
// The service worker's Radzen allowlist (service-worker.published.js) covers these files.
const CSS_ID = 'pomule-radzen-css';
// The theme follows the device like the rest of the app: Radzen's light base theme under a light
// scheme, its dark one under a dark scheme (a dark grid on a light page failed contrast).
const THEMES = [
  { id: CSS_ID, file: 'material-dark-base.css', media: '(prefers-color-scheme: dark)' },
  { id: CSS_ID + '-light', file: 'material-base.css', media: 'not all and (prefers-color-scheme: dark)' },
];

export function ensure() {
  const base = document.baseURI;
  const css = Promise.all(THEMES.map(t => document.getElementById(t.id) ? Promise.resolve() : new Promise((done) => {
    const link = document.createElement('link');
    link.id = t.id;
    link.rel = 'stylesheet';
    link.media = t.media;
    link.href = new URL(`_content/Radzen.Blazor/css/${t.file}?v=12.2.0`, base).href;
    link.onload = link.onerror = () => done();
    document.head.appendChild(link);
  })));
  const js = window.Radzen ? Promise.resolve() : new Promise((done) => {
    const script = document.createElement('script');
    script.src = new URL('_content/Radzen.Blazor/Radzen.Blazor.js?v=12.2.0', base).href;
    script.onload = script.onerror = () => done();
    document.head.appendChild(script);
  });
  return Promise.all([css, js]).then(() => true);
}

export function remove() {
  // The theme is part of the page shell now (index.html); nothing to take away.
}
