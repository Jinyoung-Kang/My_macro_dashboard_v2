#!/usr/bin/env node
// scripts/qa/nav-timing.js — 화면 안 이동 시간(링크를 누른 때부터 새 화면의 첫 내용이 그려질 때까지)을 잽니다(의존성 없음 — ui-audit.js의
// Chrome·CDP 부분을 씀). 미리 받기 정책을 바꾸기 전후를 같은 잣대로 견주려고 만들었습니다(ADR 0047, 성능 개선 작업 C2).
//
// 사용: node scripts/qa/nav-timing.js --base http://127.0.0.1:13002 [--runs 5] [--rates 1,4] [--dwell 100] [--pairs "/>/macro,/>/paper/us,/macro>/institutions"]
//   [--width 1440] [--chrome <실행 파일>]
//
// 한 번 재기(쌍 '출발>도착'마다, CPU 감속 배율마다, --runs번):
//   1. 출발 화면을 새로 열고(load 뒤 EventSource 밖의 요청이 1.5초 동안 0이 될 때까지, 최대 30초 — 보이는 링크의 미리 받기가 있으면 그것까지 끝남)
//   2. 보이는 첫 a[href="<도착>"]의 가운데로 마우스를 옮기고 --dwell ms 기다린 뒤 누름(사람이 링크 위에 포인터를 올렸다가 누르는 꼴)
//   3. 누른 때(문서 click 캡처 단계의 performance.now)부터, 주소가 도착 경로가 되고 <main> 안 h1의 글이 출발 화면과 달라진 다음 그림 틀(rAF)까지
// 출력: 쌍·배율마다 각 회 값과 중앙값(ms), 출발 화면을 여는 동안의 RSC 미리 받기 요청 수(?_rsc=) 중앙값.
// 안전: 주소 이동과 링크 누르기(화면 안 이동 GET)만 합니다. QA 스택(로그인 없는 모드)에만 쓰세요 — 로컬 스택·운영 서버에는 쓰지 않습니다.
'use strict';

const { launchChrome, Cdp, sleep } = require('./ui-audit.js');

function parseArgs(argv) {
  const opts = { base: null, runs: 5, rates: [1, 4], dwell: 100, width: 1440, chrome: null,
    pairs: [['/', '/macro'], ['/', '/paper/us'], ['/macro', '/institutions']] };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]; const value = argv[i + 1];
    if (key === '--base') { opts.base = value.replace(/\/$/, ''); i += 1; }
    else if (key === '--runs') { opts.runs = Number(value); i += 1; }
    else if (key === '--rates') { opts.rates = value.split(',').map(Number); i += 1; }
    else if (key === '--dwell') { opts.dwell = Number(value); i += 1; }
    else if (key === '--width') { opts.width = Number(value); i += 1; }
    else if (key === '--chrome') { opts.chrome = value; i += 1; }
    else if (key === '--pairs') { opts.pairs = value.split(',').map((p) => p.split('>')); i += 1; }
    else throw new Error(`모르는 인자: ${key}`);
  }
  if (!opts.base) throw new Error('--base가 필요합니다');
  return opts;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

const PROBE = (to) => `(() => {
  const h = document.querySelector('main h1');
  const prev = h ? h.textContent : null;
  const nav = { t0: null, t1: null };
  window.__navTiming = nav;
  document.addEventListener('click', () => { nav.t0 = performance.now(); }, { capture: true, once: true });
  const tick = () => {
    const now = document.querySelector('main h1');
    if (nav.t0 !== null && location.pathname === ${JSON.stringify(to)} && now && now.textContent !== prev) {
      requestAnimationFrame(() => { nav.t1 = performance.now(); });
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return prev;
})()`;

const LINK_CENTER = (to) => `(() => {
  const links = [...document.querySelectorAll('a[href=${JSON.stringify(to)}]')];
  for (const a of links) {
    const r = a.getBoundingClientRect();
    const st = getComputedStyle(a);
    if (r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && r.top >= 0 && r.bottom <= innerHeight) {
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  }
  return null;
})()`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const chrome = await launchChrome(opts.chrome);
  const browser = await Cdp.connect(chrome.wsUrl);
  try {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => browser.send(method, params, sessionId);
    const inflight = new Set(); let lastActivity = Date.now(); let rsc = 0; let loaded = false;
    browser.on('Network.requestWillBeSent', sessionId, (p) => {
      if (p.type === 'EventSource' || p.type === 'WebSocket') return;
      inflight.add(p.requestId); lastActivity = Date.now();
      if (/[?&]_rsc=/.test(p.request.url)) rsc += 1;
    });
    const done = (p) => { if (inflight.delete(p.requestId)) lastActivity = Date.now(); };
    browser.on('Network.loadingFinished', sessionId, done);
    browser.on('Network.loadingFailed', sessionId, done);
    browser.on('Page.loadEventFired', sessionId, () => { loaded = true; });
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: false });
    await send('Emulation.setDeviceMetricsOverride', { width: opts.width, height: 900, deviceScaleFactor: 1, mobile: false });
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;

    const kst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    process.stdout.write(`# ${kst} KST nav-timing base=${opts.base} width=${opts.width} dwell=${opts.dwell}ms runs=${opts.runs}\n`);
    for (const [from, to] of opts.pairs) {
      for (const rate of opts.rates) {
        await send('Emulation.setCPUThrottlingRate', { rate });
        const times = []; const prefetches = [];
        for (let run = 0; run < opts.runs; run += 1) {
          await send('Network.clearBrowserCache');
          loaded = false; inflight.clear(); rsc = 0;
          await send('Page.navigate', { url: opts.base + from });
          const start = Date.now();
          while (!loaded && Date.now() - start < 30000) await sleep(50);
          while ((inflight.size > 0 || Date.now() - lastActivity < 1500) && Date.now() - start < 30000) await sleep(100);
          prefetches.push(rsc);
          const center = await evaluate(LINK_CENTER(to));
          if (!center) { process.stdout.write(`${from} > ${to} x${rate}: 링크를 찾지 못함\n`); break; }
          await evaluate(PROBE(to));
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y });
          await sleep(opts.dwell);
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: center.x, y: center.y, button: 'left', clickCount: 1 });
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: center.x, y: center.y, button: 'left', clickCount: 1 });
          let result = null; const clickAt = Date.now();
          while (Date.now() - clickAt < 20000) {
            result = await evaluate('window.__navTiming && window.__navTiming.t1 !== null ? window.__navTiming.t1 - window.__navTiming.t0 : null');
            if (result !== null) break;
            await sleep(50);
          }
          times.push(result === null ? null : Math.round(result));
        }
        const ok = times.filter((t) => t !== null);
        process.stdout.write(`${from} > ${to} CPUx${rate}: 중앙 ${median(ok)} ms [${times.join(', ')}] · 출발 화면의 RSC 미리 받기 중앙 ${median(prefetches)}\n`);
      }
    }
    await send('Emulation.setCPUThrottlingRate', { rate: 1 });
  } finally {
    browser.close();
    await chrome.close();
  }
}

main().catch((error) => { process.stderr.write(`오류: ${error && error.stack ? error.stack : error}\n`); process.exitCode = 1; });
