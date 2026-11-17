# yuka (vendored)

Steering, flocking and nav-mesh behaviours. Used by `wwwroot/js/pocapitol/steering.js`
for the crowd. Served from this folder so the import map in `index.html` can
resolve the bare specifier `yuka` to a same-origin file — no CDN, no npm install
on the client, and the PWA service worker can precache it.

| | |
|---|---|
| Upstream | https://github.com/Mugen87/yuka |
| Licence | MIT — see [LICENSE](./LICENSE) |
| Build | the published ES module bundle, unmodified |

Vendored rather than packaged because the client is a trimmed Blazor WASM app
with no bundler: a bare npm dependency would need a build step the project does
not have.

**To upgrade:** drop the new bundle in place and re-run
`node --test tests/pocapitol-*.test.mjs`.
