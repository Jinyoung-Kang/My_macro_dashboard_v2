#!/usr/bin/env node
// scripts/qa/page-apis.js — 화면 경로마다 새로 열어, 그 화면이 부르는 /api/ 요청(시간·크기·상태)과 CLS·LCP·긴 작업·DOM 수를 모읍니다(의존성 없음 —
// ui-audit.js의 Chrome·CDP 부분을 씀). 성능 개선 2차(2026-11-24)의 재측정·전후 비교에 씁니다.
//
// 사용: node scripts/qa/page-apis.js --base http://127.0.0.1:13002 --out <결과 JSON> [--routes <파일 — 기본 scripts/qa/ui-audit-routes.txt>]
//   [--forms desktop,mobile] [--block '*/api/info/sources*'] [--chrome <실행 파일>]
//   --block: 쉼표로 나눈 주소 무늬(CDP Network.setBlockedURLs)의 요청을 막습니다 — 출처 경고 띠 없는 상태를 잴 때.
// 한 경로: 디스크 캐시를 비우고 열어 load 뒤 EventSource 밖의 요청이 2초 동안 0이 될 때까지(최대 30초) 기다린 다음 값을 읽습니다.
// 폼: desktop 1440x900(DPR 1), mobile 390x844(DPR 2, 모바일·터치 에뮬레이션). 감속 없음.
// CLS: 레이아웃 이동(layout-shift)을 모두 더합니다 — hadRecentInput을 보지 않습니다. 이 도구는 입력을 보내지 않는데, 모바일 에뮬레이션
//   (Emulation.setDeviceMetricsOverride mobile: true)에서는 크롬이 첫 수십 ms에 입력이 있었다고 표시해(lastInputTime) 모든 이동이 hadRecentInput=true가
//   되어 예전 판은 모바일 CLS가 늘 0이었습니다(2026-11-24 확인 — 같은 화면을 mobile: false 390폭으로 열면 같은 값이 나오고 Lighthouse 모바일 값과 가까움).
//   그 표시가 붙은 이동 수는 inputFlagged로 따로 적습니다. Lighthouse(scripts/qa/lighthouse.sh)는 감속·화면 크기가 달라 값이 같지 않습니다 — 견줄 때는 같은 도구끼리.
// 출력: 표준출력에 경로마다 한 줄(API 수·가장 긴 API), --out에 경로마다 {form, route, settleMs, metrics{cls, lcp, lcpEl, long, longN, shifts[[ms, 값, 요소]],
//   inputFlagged, dom}, apis[], scriptBytes, rsc, requests}.
// 안전: 주소 이동(GET)만 합니다. QA 스택(로그인 없는 모드)에만 쓰세요 — 로컬 스택·운영 서버에는 쓰지 않습니다(CLAUDE.md).
'use strict';
const fs = require('fs');
const path = require('path');

const { launchChrome, Cdp, sleep } = require('./ui-audit.js');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  if (!['base', 'out', 'routes', 'forms', 'block', 'chrome'].includes(key)) throw new Error(`모르는 인자: ${process.argv[i]}`);
  args[key] = process.argv[i + 1];
}
if (!args.base || !args.out) throw new Error('--base와 --out이 필요합니다(머리 설명).');
const base = args.base.replace(/\/$/, '');
const routes = fs.readFileSync(args.routes || path.join(__dirname, 'ui-audit-routes.txt'), 'utf8').split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
const forms = (args.forms || 'desktop,mobile').split(',');
const FORM = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
};

const OBSERVER = `(() => {
  const m = { cls: 0, lcp: null, lcpEl: null, long: 0, longN: 0, shifts: [], inputFlagged: 0 };
  window.__m = m;
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (e.hadRecentInput) m.inputFlagged += 1; { m.cls += e.value;
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
