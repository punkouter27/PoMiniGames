// Builds SCREENSHOTS/<yymmdd>-<feature>.html (before | after per screen, with notes) and the single annotated
// side-by-side SCREENSHOTS/<yymmdd>-<feature>.png from two folders of <slug>-<width>.png captures.
// Thumbnails are downscaled PNGs in SCREENSHOTS/<yymmdd>-<feature>/ so every image stays small.
// Usage: node compose.mjs <beforeDir> <afterDir> <screenshotsDir> <yymmdd-feature> <title> [note...]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [beforeDir, afterDir, shotsDir, name, title, ...notes] = process.argv.slice(2);
if (!beforeDir || !afterDir || !shotsDir || !name) {
  console.error('usage: node compose.mjs <beforeDir> <afterDir> <screenshotsDir> <yymmdd-feature> <title> [note...]');
  process.exit(2);
}
const thumbDir = path.join(shotsDir, name);
fs.mkdirSync(thumbDir, { recursive: true });

// Screens present on both sides, in capture order (desktop first).
const pngs = (d) => fs.readdirSync(d).filter(f => /-\d+\.png$/.test(f));
const screens = pngs(afterDir).filter(f => fs.existsSync(path.join(beforeDir, f)))
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
if (screens.length === 0) { console.error('no screen is in both folders'); process.exit(1); }

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const browser = await chromium.launch();
const page = await browser.newPage();

// Downscale each capture in the browser (canvas) to a small PNG: desktop 560 px wide, phone 220 px.
async function thumb(src, dest) {
  const width = /-390\.png$|-375\.png$/.test(src) ? 220 : 560;
  const data = fs.readFileSync(src).toString('base64');
  const out = await page.evaluate(async ({ data, width }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = width; c.height = Math.round(img.height * width / img.width);
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png').split(',')[1];
  }, { data, width });
  fs.writeFileSync(dest, Buffer.from(out, 'base64'));
}

const rows = [];
for (const f of screens) {
  const base = f.replace(/\.png$/, '');
  await thumb(path.join(beforeDir, f), path.join(thumbDir, `${base}-before.png`));
  await thumb(path.join(afterDir, f), path.join(thumbDir, `${base}-after.png`));
  const [, screen, width] = base.match(/^(.*)-(\d+)$/);
  rows.push({ base, screen, width });
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)}</title>
<style>
  :root { color-scheme: light; font-family: Inter, system-ui, sans-serif; }
  body { margin: 0; padding: 16px; background: #f6f7fb; color: #1b1f2a; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #4a5163; font-size: 13px; margin: 0 0 12px; }
  ul.notes { margin: 0 0 16px; padding-left: 20px; font-size: 13px; }
  section { background: #fff; border: 1px solid #dfe3ec; border-radius: 10px; padding: 10px; margin: 0 0 12px; }
  h2 { font-size: 14px; margin: 0 0 8px; }
  .pair { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
  figure { margin: 0; }
  figcaption { font-size: 12px; font-weight: 600; margin: 0 0 4px; }
  figcaption.before { color: #9a3412; } figcaption.after { color: #166534; }
  img { display: block; max-width: 100%; border: 1px solid #dfe3ec; border-radius: 6px; }
</style></head>
<body>
<h1>${esc(title || name)}</h1>
<p class="meta">PoMiniGames · ${esc(name)} · before | after, 1366×768 and 390×844, captured locally (scripts/screenshots.ps1)</p>
${notes.length ? `<ul class="notes">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
${rows.map(r => `<section><h2>${esc(r.screen === 'home' ? '/' : '/' + r.screen.replace(/-/g, '/'))} · ${r.width} px</h2>
<div class="pair">
<figure><figcaption class="before">Before</figcaption><img src="${esc(name)}/${r.base}-before.png" alt="Before: ${esc(r.screen)} at ${r.width} px"></figure>
<figure><figcaption class="after">After</figcaption><img src="${esc(name)}/${r.base}-after.png" alt="After: ${esc(r.screen)} at ${r.width} px"></figure>
</div></section>`).join('\n')}
</body></html>
`;
const htmlPath = path.join(shotsDir, `${name}.html`);
fs.writeFileSync(htmlPath, html);

// The single annotated side-by-side PNG: the same page, rendered at a reduced scale so it stays small.
const sheet = await (await browser.newContext({ viewport: { width: 1180, height: 800 }, deviceScaleFactor: 0.5 })).newPage();
await sheet.goto(pathToFileURL(htmlPath).href);
await sheet.waitForLoadState('load');
const pngPath = path.join(shotsDir, `${name}.png`);
await sheet.screenshot({ path: pngPath, fullPage: true });
await browser.close();
for (const f of [htmlPath, pngPath]) console.log('wrote', f, `${Math.round(fs.statSync(f).size / 1024)} KB`);
