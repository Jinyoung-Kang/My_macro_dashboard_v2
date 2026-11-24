#!/usr/bin/env node
// 임시(저장소 밖): 화면 경로마다 열어서 그 화면이 부르는 /api/ 요청(시간·크기·상태)과 CLS·LCP·긴 작업·DOM 수를 모은다.
// QA 스택에만 쓴다. 저장소의 scripts/qa/ui-audit.js가 내보내는 Chrome·CDP 도우미를 쓴다.
// 사용: node page-apis.js --repo <저장소> --base http://127.0.0.1:13002 --routes <파일> --out <json> [--forms desktop,mobile]
'use strict';
const fs = require('fs');
const path = require('path');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const { launchChrome, Cdp, sleep } = require(path.join(args.repo, 'scripts/qa/ui-audit.js'));
const base = args.base.replace(/\/$/, '');
const routes = fs.readFileSync(args.routes, 'utf8').split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
const forms = (args.forms || 'desktop,mobile').split(',');
const FORM = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
};

const OBSERVER = `(() => {
  const m = { cls: 0, lcp: null, lcpEl: null, long: 0, longN: 0, shifts: [] };
  window.__m = m;
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (!e.hadRecentInput) { m.cls += e.value;
      const src = (e.sources || []).map((s) => { const n = s.node; if (!n || !n.tagName) return null;
        return n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (typeof n.className === 'string' && n.className ? '.' + n.className.split(/\\s+/).slice(0, 2).join('.') : ''); }).filter(Boolean).slice(0, 2);
      m.shifts.push([Math.round(e.startTime), Math.round(e.value * 1000) / 1000, src]); } } }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { m.lcp = Math.round(e.startTime);
      const n = e.element; m.lcpEl = n ? (n.tagName.toLowerCase() + ':' + (n.textContent || '').trim().slice(0, 40)) : null; } }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { m.long += Math.max(0, e.duration - 50); m.longN += 1; } }).observe({ type: 'longtask', buffered: true });
  } catch (e) { m.err = String(e); }
})()`;

(async () => {
  const chrome = await launchChrome(args.chrome || null);
  const browser = await Cdp.connect(chrome.wsUrl);
  const out = [];
  try {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => browser.send(method, params, sessionId);
    const reqs = new Map(); const inflight = new Set(); let lastActivity = Date.now(); let loaded = false;
    browser.on('Network.requestWillBeSent', sessionId, (p) => {
      const sse = p.type === 'EventSource' || p.type === 'WebSocket';
      reqs.set(p.requestId, { url: p.request.url, method: p.request.method, type: p.type, t0: p.timestamp, sse });
      if (!sse) { inflight.add(p.requestId); lastActivity = Date.now(); }
    });
    browser.on('Network.responseReceived', sessionId, (p) => {
      const r = reqs.get(p.requestId); if (!r) return;
      r.status = p.response.status; r.tHead = p.timestamp; r.fromCache = !!p.response.fromDiskCache;
    });
    const done = (failed) => (p) => {
      const r = reqs.get(p.requestId); if (r) { r.t1 = p.timestamp; r.bytes = p.encodedDataLength || 0; if (failed) r.failed = p.errorText || 'failed'; }
      if (inflight.delete(p.requestId)) lastActivity = Date.now();
    };
    browser.on('Network.loadingFinished', sessionId, done(false));
    browser.on('Network.loadingFailed', sessionId, done(true));
    browser.on('Page.loadEventFired', sessionId, () => { loaded = true; });
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER });
    if (args.block) await send('Network.setBlockedURLs', { urls: args.block.split(',') });
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;

    for (const form of forms) {
      await send('Emulation.setDeviceMetricsOverride', FORM[form]);
      await send('Emulation.setTouchEmulationEnabled', { enabled: form === 'mobile' });
      for (const route of routes) {
        await send('Network.clearBrowserCache');
        reqs.clear(); inflight.clear(); loaded = false; lastActivity = Date.now();
        const start = Date.now();
        await send('Page.navigate', { url: base + route });
        while (!loaded && Date.now() - start < 30000) await sleep(50);
        while ((inflight.size > 0 || Date.now() - lastActivity < 2000) && Date.now() - start < 30000) await sleep(100);
        const settleMs = Date.now() - start;
        const m = await evaluate('JSON.stringify(Object.assign({}, window.__m || {}, { dom: document.getElementsByTagName("*").length, title: document.title }))');
        const all = [...reqs.values()];
        const apis = all.filter((r) => /\/api\//.test(r.url)).map((r) => ({
          method: r.method, url: r.url.replace(/^https?:\/\/[^/]+/, ''), status: r.status ?? null, sse: r.sse,
          ttfb: r.tHead ? Math.round((r.tHead - r.t0) * 1000) : null, total: r.t1 ? Math.round((r.t1 - r.t0) * 1000) : null,
          bytes: r.bytes ?? null, failed: r.failed ?? null, pending: !r.t1,
        }));
        const scripts = all.filter((r) => r.type === 'Script');
        out.push({ form, route, settleMs, stillInflight: inflight.size, metrics: JSON.parse(m || '{}'), apis,
          scriptCount: scripts.length, scriptBytes: scripts.reduce((s, r) => s + (r.bytes || 0), 0),
          rsc: all.filter((r) => /[?&]_rsc=/.test(r.url)).length, requests: all.length });
        const slow = apis.filter((a) => !a.sse).sort((a, b) => (b.total || 0) - (a.total || 0))[0];
        process.stdout.write(`${form.padEnd(7)} ${route.padEnd(52)} api=${String(apis.length).padStart(3)} 최장=${slow ? String(slow.total).padStart(5) + 'ms ' + slow.url.slice(0, 60) : '-'}\n`);
      }
    }
  } finally {
    fs.writeFileSync(args.out, JSON.stringify(out));
    browser.close();
    await chrome.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
