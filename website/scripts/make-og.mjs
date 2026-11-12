/**
 * Regenerates public/og.png (1200x630, website) and ../docs/social-preview.png (1280x640, the image to
 * upload in GitHub: Settings → General → Social preview) from the real hero screenshot.
 * Not part of the build: the PNG is committed. Needs playwright-core (the repo root has it after
 * `npm ci`) and a Chromium-based browser:
 *   PLAYWRIGHT_CORE=../node_modules/playwright-core BROWSER=<path to msedge.exe/chrome.exe> node scripts/make-og.mjs
 */
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(path.resolve(here, process.env.PLAYWRIGHT_CORE ?? '../../node_modules/playwright-core'));
const browserPath = process.env.BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const shot = pathToFileURL(path.resolve(here, '../src/assets/shots/hero.png')).href;
const icon = pathToFileURL(path.resolve(here, '../public/icon.png')).href;
const html = `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html{background:#0c0c0e}
body{width:1200px;height:630px;overflow:hidden;background:#0c0c0e;transform-origin:0 0;color:#ededf2;font-family:'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif;position:relative}
.glow{position:absolute;right:-200px;top:-200px;width:800px;height:800px;background:radial-gradient(closest-side,rgba(47,107,255,.22),transparent)}
.brand{position:absolute;left:64px;top:56px;display:flex;align-items:center;gap:16px;font-size:34px;font-weight:700;letter-spacing:-.02em}
.brand img{width:44px;height:44px}
h1{position:absolute;left:64px;top:150px;width:520px;font-size:56px;line-height:1.08;letter-spacing:-.03em;font-weight:750}
h1 span{color:#7fa6ff}
p{position:absolute;left:64px;bottom:64px;font-size:24px;color:#8e8e99}
.shot{position:absolute;left:640px;top:150px;width:720px;border-radius:14px;border:1px solid #26262b;box-shadow:0 30px 70px rgba(0,0,0,.6)}
</style>
<div class="glow"></div>
<div class="brand"><img src="${icon}">SplitNest</div>
<h1>The Windows terminal workspace built for <span>AI coding agents</span></h1>
<p>PowerShell and WSL · Claude Code, Codex, Gemini CLI</p>
<img class="shot" src="${shot}">`;

const tmp = path.resolve(here, '.og.html');
fs.writeFileSync(tmp, html);
const browser = await chromium.launch({ executablePath: browserPath });
const outputs = [
  { file: '../public/og.png', width: 1200, height: 630 },
  // GitHub's recommended size; the 1200x630 design is scaled to the height and centred.
  { file: '../../docs/social-preview.png', width: 1280, height: 640 },
];
for (const o of outputs) {
  const page = await browser.newPage({ viewport: { width: o.width, height: o.height } });
  await page.goto(pathToFileURL(tmp).href);
  await page.waitForLoadState('load');
  const scale = o.height / 630;
  const left = (o.width - 1200 * scale) / 2;
  await page.evaluate(([s, l]) => { document.body.style.transform = `translate(${l}px,0) scale(${s})`; }, [scale, left]);
  await page.screenshot({ path: path.resolve(here, o.file) });
  await page.close();
  console.log(`wrote ${o.file} (${o.width}x${o.height})`);
}
await browser.close();
fs.unlinkSync(tmp);
