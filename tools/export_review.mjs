import { readFile, writeFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const assets = new URL('public/sites/columbia-hills/review/', root)
const maps = {}
for (const name of ['optical-detail.png', 'optical-overlay.png', 'hillshade-detail.png', 'hillshade-overlay.png', 'footprint-overview.png']) {
  maps[name] = `data:image/png;base64,${(await readFile(new URL(name, assets))).toString('base64')}`
}
const report = JSON.parse(await readFile(new URL('coverage-review.json', assets), 'utf8'))
const payload = JSON.stringify({ report, maps }).replaceAll('<', '\\u003c')
const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'browser', define: { 'import.meta.env.BASE_URL': JSON.stringify('./') } })
const script = await transpiler.transform(await readFile(new URL('src/review.ts', root), 'utf8'))
const css = await readFile(new URL('src/review.css', root), 'utf8')
let html = await readFile(new URL('review.html', root), 'utf8')
html = html.replace('<link rel="stylesheet" href="/src/review.css">', `<style>${css}</style>`)
for (const [name, data] of Object.entries(maps)) html = html.replaceAll(`./sites/columbia-hills/review/${name}`, data)
html = html.replace('href="./index.html"', 'href="#top"').replace('<body>', '<body id="top">')
const record = `data:application/json;base64,${Buffer.from(JSON.stringify(report, null, 2)).toString('base64')}`
html = html.replace('href="./sites/columbia-hills/review/coverage-review.json"', `href="${record}" download="coverage-review.json"`)
html = html.replace('<script type="module" src="/src/review.ts"></script>', `<script type="application/json" id="embedded-review">${payload}</script><script type="module">${script.replaceAll('</script', '<\\/script')}</script>`)
await writeFile(new URL('docs/phase-1-review.html', root), html)
console.log('Exported docs/phase-1-review.html: opens directly from disk with embedded maps and verification data.')
