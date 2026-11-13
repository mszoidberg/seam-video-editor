import * as esbuild from 'esbuild';
import fs from 'node:fs';
const out = 'dist';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
await esbuild.build({
  entryPoints: { app: 'src/main.js' },
  bundle: true, format: 'esm', splitting: true, minify: true, target: ['chrome111', 'safari16.4', 'firefox128'],
  outdir: out, chunkNames: 'chunk-[hash]', legalComments: 'none',
});
for (const f of fs.readdirSync(out)) if (f.endsWith('.js') && fs.statSync(`${out}/${f}`).size === 0) fs.writeFileSync(`${out}/${f}`, 'export {};\n');
const css = fs.readFileSync('src/styles.css', 'utf8');
const body = fs.readFileSync('src/body.html', 'utf8');
const fill = (f) => fs.readFileSync(f, 'utf8').replace('/*__CSS__*/', () => css).replace('/*__BODY__*/', () => body);
fs.writeFileSync(`${out}/index.html`, fill('src/index.html'));
// claude.ai page build: same app, no service worker or manifest.
const art = 'dist-artifact';
fs.rmSync(art, { recursive: true, force: true });
fs.mkdirSync(art);
fs.writeFileSync(`${art}/seam.html`, fill('src/artifact.html'));
for (const f of fs.readdirSync(out)) if (f.endsWith('.js') && f !== 'sw.js') fs.copyFileSync(`${out}/${f}`, `${art}/${f}`);
for (const f of fs.readdirSync('public')) fs.copyFileSync(`public/${f}`, `${out}/${f}`);
const version = Date.now().toString(36);
const files = ['./', ...fs.readdirSync(out).filter((f) => !['index.html', 'sw.js'].includes(f))];
fs.writeFileSync(`${out}/sw.js`, fs.readFileSync(`${out}/sw.js`, 'utf8').replace('__VERSION__', version).replace('__FILES__', JSON.stringify(files)));
console.log(fs.readdirSync(out).map((f) => `${f} ${fs.statSync(`${out}/${f}`).size}`).join('\n'));
