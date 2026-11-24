// Captures each route of a running PoMiniGames host at 1366x768 and 390x844 into <outDir>/<slug>-<width>.png.
// Called by scripts/screenshots.ps1; local hosts only (never the live site).
// Usage: node capture.mjs <baseUrl> <outDir> <route> [route...]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const [base, outDir, ...routes] = process.argv.slice(2);
if (!base || !outDir || routes.length === 0) {
  console.error('usage: node capture.mjs <baseUrl> <outDir> <route> [route...]');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const slug = (r) => (r.replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9]+/gi, '-') || 'home').toLowerCase();

// Real GPU on Windows (ANGLE over D3D11): the 3D games crawl under the software rasteriser.
const args = process.platform === 'win32' ? ['--use-angle=d3d11', '--ignore-gpu-blocklist'] : [];
const browser = await chromium.launch({ args });
for (const size of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  const phone = size.width < 500;
  const ctx = await browser.newContext({ viewport: size, isMobile: phone, hasTouch: phone, colorScheme: 'light', reducedMotion: 'reduce' });
  // A returning player: saved initials keep the first-visit prompt shut, so the page itself is captured.
  await ctx.addInitScript(() => { try { localStorage.setItem('pominigames:initials', 'TST'); } catch { /* blocked */ } });
  const page = await ctx.newPage();
  for (const route of routes) {
    try {
      await page.goto(new URL(route, base).href, { waitUntil: 'load', timeout: 300000 });
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await page.waitForSelector('h1, .home-card, .gps-intro-card', { timeout: 120000 }).catch(() => {});
      await page.waitForTimeout(3000);
      const file = path.join(outDir, `${slug(route)}-${size.width}.png`);
      await page.screenshot({ path: file });
      console.log('captured', file);
    } catch (e) {
      console.error(`could not capture ${route} at ${size.width}: ${e.message.split('\n')[0]}`);
    }
  }
  await ctx.close();
}
await browser.close();
