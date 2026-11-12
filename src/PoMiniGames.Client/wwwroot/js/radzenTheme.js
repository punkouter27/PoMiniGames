// Radzen's theme stylesheet and script, on demand, for a page that uses Radzen components
// (Brawl HQ). Radzen's theme is global CSS, so it is only in the document while such a page
// is; the rest of the app keeps its plain CSS. Same element id and files as PoMule's own
// loader (js/pomule/index.js ensureRadzen), so the two never add it twice, and the service
// worker's Radzen allowlist (service-worker.published.js) already covers both files.
const CSS_ID = 'pomule-radzen-css';

export function ensure() {
  const base = document.baseURI;
  const css = document.getElementById(CSS_ID) ? Promise.resolve() : new Promise((done) => {
    const link = document.createElement('link');
    link.id = CSS_ID;
    link.rel = 'stylesheet';
    link.href = new URL('_content/Radzen.Blazor/css/material-dark-base.css?v=12.1.12', base).href;
    link.onload = link.onerror = () => done();
    document.head.appendChild(link);
  });
  const js = window.Radzen ? Promise.resolve() : new Promise((done) => {
    const script = document.createElement('script');
    script.src = new URL('_content/Radzen.Blazor/Radzen.Blazor.js?v=12.1.12', base).href;
    script.onload = script.onerror = () => done();
    document.head.appendChild(script);
  });
  return Promise.all([css, js]).then(() => true);
}

export function remove() {
  document.getElementById(CSS_ID)?.remove();
}
