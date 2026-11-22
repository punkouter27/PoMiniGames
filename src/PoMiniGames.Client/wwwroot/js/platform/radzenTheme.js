// Radzen's theme stylesheet and script, on demand, for a page that uses Radzen components
// (Brawl HQ). Radzen's theme is global CSS, so it is only in the document while such a page
// is; the rest of the app keeps its plain CSS. Same element id and files as PoMule's own
// loader (js/pomule/index.js ensureRadzen), so the two never add it twice, and the service
// worker's Radzen allowlist (service-worker.published.js) already covers both files.
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
  for (const t of THEMES) document.getElementById(t.id)?.remove();
}
