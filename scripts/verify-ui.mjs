// End-to-end check of the visitor experience with real pointer and keyboard events.
//   node scripts/verify-ui.mjs <outDir> [--size=960x600] [--mobile] [--real]
// Verifies: scene becomes ready, hint shows, the control opens and changes light and tide,
// tapping the water makes ripples, tapping an animal opens a close look with its caption,
// Escape returns, sound toggles. Saves screenshots. Headless Chromium uses SwiftShader, so
// timings say nothing about real hardware.
import { chromium, devices } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const outDir = args.find(a => !a.startsWith('--')) ?? 'capturas/ui';
const opt = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? 'true']; }));
fs.mkdirSync(outDir, { recursive: true });
const real = opt.real === 'true';
const server = real ? null : await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
if (server) await server.listen();
const base = real ? pathToFileURL(path.resolve('dist/index.html')).href : server.resolvedUrls.local[0];
const executablePath = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = real ? await chromium.connectOverCDP('http://127.0.0.1:9223') : await chromium.launch({ executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const [W, H] = (opt.size ?? '960x600').split('x').map(Number);
const context = real ? browser.contexts()[0] : opt.mobile ? await browser.newContext({ ...devices['iPhone 13'] }) : await browser.newContext({ viewport: { width: W, height: H } });
const page = await context.newPage();
if (real) await page.bringToFront();
const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });
const results = {};
const step = async (name, fn) => {
  try { results[name] = (await fn()) ?? 'ok'; } catch (e) { results[name] = `FAIL: ${e.message.split('\n')[0]}`; }
};
const shot = name => page.screenshot({ path: path.join(outDir, `${name}.png`), timeout: 120000 });

await page.goto(`${base}?q=${real ? 'medium' : 'low'}${opt.query ? '&' + opt.query : ''}`, { waitUntil: 'domcontentloaded' });
await step('ready', async () => {
  await page.waitForFunction(() => window.__tidepool?.ready, null, { timeout: 240000 });
  return page.evaluate(() => window.__tidepool.stats().tier);
});
await page.waitForTimeout(2500);
await step('hint visible', () => page.evaluate(() => getComputedStyle(document.getElementById('hint')).opacity));
await shot('1-start');

await step('open control', async () => {
  await page.click('#pill');
  await page.waitForSelector('#panel:not([hidden])', { timeout: 5000 });
  return page.evaluate(() => document.getElementById('pill').getAttribute('aria-expanded'));
});
await step('set light to sunset', async () => {
  await page.$eval('#light', el => { el.value = '760'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  return page.evaluate(() => `${document.getElementById('light-label').textContent} | hour ${window.__tidepool.app.hour.toFixed(2)}`);
});
await step('set tide high', async () => {
  await page.$eval('#tide', el => { el.value = '900'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  return page.evaluate(() => `${document.getElementById('tide-label').textContent} | tide ${window.__tidepool.app.tide.toFixed(2)}`);
});
await page.waitForTimeout(1500);
await shot('2-control');
await step('close control with Escape', async () => {
  await page.keyboard.press('Escape');
  return page.evaluate(() => document.getElementById('panel').hidden ? 'closed' : 'still open');
});
// Back to a calm afternoon for the rest.
await page.evaluate(() => { const t = window.__tidepool; t.setHour(16.4); t.setTide(0.35); });

await step('tap water makes ripples', async () => {
  const pt = await page.evaluate(() => {
    const app = window.__tidepool.app;
    const v = new app.camera.position.constructor(0.3, app.water.levelAt(0.3, -0.3), -0.3).project(app.camera);
    const r = app.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
  });
  const before = await page.evaluate(() => window.__tidepool.app.water.ripples.impulses?.length ?? 0);
  await page.mouse.click(pt.x, pt.y);
  const queued = await page.evaluate(() => window.__tidepool.app.water.ripples.impulses?.length ?? 0);
  return `impulses queued ${before} -> ${queued}`;
});
await page.waitForTimeout(1200);
await shot('3-ripple');

await step('tap an anemone opens a close look', async () => {
  const pt = await page.evaluate(() => {
    const app = window.__tidepool.app;
    const cams = app.life.clickables.filter(c => c.label.includes('Giant'));
    // The most central one in view.
    let best = null, bd = 9;
    for (const c of cams) {
      const v = c.focus().project(app.camera);
      const d = Math.hypot(v.x, v.y);
      if (v.z < 1 && d < bd) { bd = d; best = v; }
    }
    const r = app.renderer.domElement.getBoundingClientRect();
    return best ? { x: r.left + (best.x * 0.5 + 0.5) * r.width, y: r.top + (-best.y * 0.5 + 0.5) * r.height } : null;
  });
  if (!pt) throw new Error('no anemone on screen');
  const probe = await page.evaluate(({ x, y }) => {
    const exp = window.__tidepool.experience;
    const ray = exp.rayFrom(x, y);
    const hit = window.__tidepool.app.life.pick(ray);
    return hit ? hit.label : 'no pick';
  }, pt);
  results['pick probe'] = probe;
  const trace = await page.evaluate(() => {
    const el = window.__tidepool.app.renderer.domElement;
    const log = [];
    for (const t of ['pointerdown', 'pointerup', 'click']) el.addEventListener(t, e => log.push(`${t}@${Math.round(e.timeStamp)}`), { once: true });
    window.__trace = log;
    return true;
  });
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(300);
  results['actual click'] = await page.evaluate(() => {
    const exp = window.__tidepool.experience;
    return `macro ${!!exp.macro} caption ${document.getElementById('caption-name').textContent}`;
  });
  if (!results['actual click'].startsWith('macro true')) throw new Error('animal click did not open macro');
  results['event trace'] = await page.evaluate(p => `${window.__trace.join(' ')} | at point: ${document.elementFromPoint(p.x, p.y)?.id || document.elementFromPoint(p.x, p.y)?.tagName}`, pt);
  // Wait for the lens to arrive rather than a fixed time: under SwiftShader a frame can take a
  // second or more, and the camera only moves when frames are drawn.
  await page.waitForFunction(() => {
    const a = window.__tidepool.app;
    return a.camera.position.distanceTo(a.rig.current.target) <= 0.55;
  }, null, { timeout: 30000, polling: 250 }).catch(() => {});
  const view = await page.evaluate(() => {
    const a = window.__tidepool.app;
    return { label: document.getElementById('caption-name').textContent, caption: document.getElementById('caption').classList.contains('shown'), distance: a.camera.position.distanceTo(a.rig.current.target) };
  });
  if (view.distance > 0.55) throw new Error(`macro lens stayed ${view.distance.toFixed(2)} m from the animal`);
  return `${view.label} | caption ${view.caption} | lens ${view.distance.toFixed(2)} m`;
});
await shot('4-macro');
await step('Escape returns', async () => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2600);
  return page.evaluate(() => `caption hidden ${document.getElementById('caption').hidden} | dist ${window.__tidepool.app.rig.current.distance.toFixed(2)}`);
});
await step('drag rotates the view', async () => {
  const az0 = await page.evaluate(() => window.__tidepool.app.rig.pose.azimuth);
  // The page's own size (a phone is narrower than --size), and on a phone a real finger drag.
  const vp = page.viewportSize() ?? { width: W, height: H };
  const from = { x: vp.width * 0.5, y: vp.height * 0.5 }, to = { x: vp.width * 0.3, y: vp.height * 0.45 };
  if (opt.mobile) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
    for (let i = 1; i <= 6; i++) {
      const t = i / 6;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
  }
  const az1 = await page.evaluate(() => window.__tidepool.app.rig.pose.azimuth);
  return `azimuth ${az0.toFixed(2)} -> ${az1.toFixed(2)}`;
});
await step('sound toggles', async () => {
  await page.click('#sound');
  await page.waitForTimeout(500);
  return page.evaluate(() => `${document.getElementById('sound').getAttribute('aria-pressed')} | ${document.getElementById('sound').getAttribute('aria-label')}`);
});
await shot('5-end');
if (real) await page.click('#sound'); // leave Adolfo's browser silent
results.errors = errors.slice(0, 10);
console.log(JSON.stringify(results, null, 1));
await page.close();
await browser.close();
if (server) await server.close();
if (Object.values(results).some(v => typeof v === 'string' && v.startsWith('FAIL:')) || errors.length) process.exitCode = 1;
