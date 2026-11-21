#!/usr/bin/env node
// scripts/qa/render-profile.js — 화면을 처음 열 때 React가 어느 컴포넌트를 몇 번, 얼마 동안 그리는지 셉니다(의존성 없음 — ui-audit.js의 Chrome·CDP).
// 성능 개선 작업 B1(매크로 화면 원인 좁히기, ADR 0047)용. React DevTools가 쓰는 전역 훅 자리(__REACT_DEVTOOLS_GLOBAL_HOOK__)에 작은 기록기를 먼저 넣고,
// React가 커밋마다 부르는 onCommitFiberRoot에서 '이번 커밋에 그린' 컴포넌트(새로 붙음, 또는 PerformedWork 표시 — DevTools의 didFiberRender와 같은 규칙,
// 바뀌지 않은 하위 트리는 건너뜀)를 셉니다.
//
// 걸리는 시간(selfBaseDuration·actualDuration)은 운영 빌드에 React 프로파일링을 켜야(next build --profile) 값이 있고, 컴포넌트 이름은 이름 줄이기를
// 끄야(--no-mangling) 읽힙니다 — QA 화면을 그렇게 빌드했을 때만 씁니다(빌드 방법은 진행 기록). 그 밖의 빌드에서는 횟수만 뜻이 있습니다.
//
// 사용: node scripts/qa/render-profile.js --base http://127.0.0.1:13002 [--route /macro] [--rate 4] [--width 390] [--settle 20000] [--runs 1] [--top 30]
//   --raw <파일>: 커밋마다의 기록(시각·그리기 ms·컴포넌트별 횟수·자기 시간)을 JSON으로도 씀(마지막 회차).
//   --settle: load 뒤 이만큼(ms) 더 지켜봄(늦게 오는 응답·실시간 값·분 시계에 따른 다시 그리기까지). 실시간 시세 SSE는 QA에서 막혀 있음.
// 출력: 커밋 수·그리기 시간 합(HostRoot actualDuration 합), 1초 구간별 커밋 수·시간, 컴포넌트별 그린 횟수·자기 시간 합(위에서 --top개), 긴 작업(longtask) 수·합.
// 안전: 주소 이동(GET)만 합니다. QA 스택(로그인 없는 모드)에만 쓰세요.
'use strict';

const { launchChrome, Cdp, sleep } = require('./ui-audit.js');

function parseArgs(argv) {
  const opts = { base: null, route: '/macro', rate: 4, width: 390, settle: 20000, runs: 1, top: 30, chrome: null, raw: null };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]; const value = argv[i + 1];
    if (key === '--base') opts.base = value.replace(/\/$/, '');
    else if (key === '--route') opts.route = value;
    else if (key === '--rate') opts.rate = Number(value);
    else if (key === '--width') opts.width = Number(value);
    else if (key === '--settle') opts.settle = Number(value);
    else if (key === '--runs') opts.runs = Number(value);
    else if (key === '--top') opts.top = Number(value);
    else if (key === '--chrome') opts.chrome = value;
    else if (key === '--raw') opts.raw = value;
    else throw new Error(`모르는 인자: ${key}`);
  }
  if (!opts.base) throw new Error('--base가 필요합니다');
  return opts;
}

// 페이지보다 먼저 실행됩니다. React가 이 훅에 자신을 등록하고(inject) 커밋마다 onCommitFiberRoot를 부릅니다.
const RECORDER = `(() => {
  const NAMED = new Set([0, 1, 11, 14, 15]); // FunctionComponent·ClassComponent·ForwardRef·MemoComponent·SimpleMemoComponent
  const PERFORMED_WORK = 1;
  const nameOf = (fiber) => {
    const type = fiber.type;
    if (!type) return '(이름 없음)';
    if (typeof type === 'function') return type.displayName || type.name || '(이름 없음)';
    if (type.render) return type.displayName || type.render.displayName || type.render.name || '(forwardRef)';
    if (type.type) return type.displayName || type.type.displayName || type.type.name || '(memo)';
    return '(그 밖)';
  };
  const log = { commits: [], longTasks: [] };
  window.__renderProfile = log;
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) log.longTasks.push([Math.round(e.startTime), Math.round(e.duration)]); })
      .observe({ type: 'longtask', buffered: true });
  } catch (e) { /* 지원 안 함 */ }
  let nextId = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject(renderer) { nextId += 1; this.renderers.set(nextId, renderer); return nextId; },
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      const comps = {};
      const stack = [root.current];
      while (stack.length) {
        const fiber = stack.pop();
        const prev = fiber.alternate;
        const rendered = prev === null || (fiber.flags & PERFORMED_WORK) === PERFORMED_WORK;
        if (rendered && NAMED.has(fiber.tag)) {
          const name = nameOf(fiber);
          const c = comps[name] || (comps[name] = [0, 0]);
          c[0] += 1;
          c[1] += fiber.selfBaseDuration || 0;
        }
        if (fiber.sibling) stack.push(fiber.sibling);
        // 바뀌지 않은 하위 트리(이번 커밋에 손대지 않음 — 자식이 같은 객체)는 건너뜁니다.
        if (fiber.child && (prev === null || fiber.child !== prev.child)) stack.push(fiber.child);
      }
      log.commits.push({ t: Math.round(performance.now()), ms: root.current.actualDuration || 0, comps });
    },
  };
})()`;

async function profileOnce(browser, opts) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => browser.send(method, params, sessionId);
  let loaded = false;
  browser.on('Page.loadEventFired', sessionId, () => { loaded = true; });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  const mobile = opts.width < 1024;
  await send('Emulation.setDeviceMetricsOverride', { width: opts.width, height: mobile ? 844 : 900, deviceScaleFactor: 1, mobile });
  await send('Emulation.setCPUThrottlingRate', { rate: opts.rate });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });
  await send('Page.navigate', { url: opts.base + opts.route });
  const start = Date.now();
  while (!loaded && Date.now() - start < 60000) await sleep(100);
  await sleep(opts.settle);
  const { result } = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__renderProfile)', returnByValue: true });
  await browser.send('Target.closeTarget', { targetId });
  return JSON.parse(result.value);
}

function report(log, opts, run) {
  const commits = log.commits;
  const total = commits.reduce((s, c) => s + c.ms, 0);
  const byComp = {};
  for (const c of commits) {
    for (const [name, [count, self]] of Object.entries(c.comps)) {
      const r = byComp[name] || (byComp[name] = { count: 0, self: 0, commits: 0 });
      r.count += count; r.self += self; r.commits += 1;
    }
  }
  const buckets = {};
  for (const c of commits) {
    const k = Math.floor(c.t / 1000);
    const b = buckets[k] || (buckets[k] = { n: 0, ms: 0 });
    b.n += 1; b.ms += c.ms;
  }
  const lt = log.longTasks;
  const lines = [];
  lines.push(`## ${opts.route} 회차 ${run} (CPU x${opts.rate}, 폭 ${opts.width}, 지켜본 시간 load + ${opts.settle} ms)`);
  lines.push(`커밋 ${commits.length}개 · 그리기 시간 합(actualDuration) ${total.toFixed(0)} ms · 긴 작업 ${lt.length}개 합 ${lt.reduce((s, t) => s + t[1], 0)} ms`);
  lines.push(`1초 구간별(시작 초: 커밋 수/그리기 ms): ${Object.entries(buckets).map(([k, b]) => `${k}s:${b.n}/${b.ms.toFixed(0)}`).join(' ')}`);
  lines.push(`가장 무거운 커밋 다섯(시각 ms·그리기 ms): ${[...commits].sort((a, b) => b.ms - a.ms).slice(0, 5).map((c) => `${c.t}:${c.ms.toFixed(0)}`).join(' ')}`);
  lines.push('컴포넌트(자기 시간 합 순) | 그린 횟수 | 나온 커밋 수 | 자기 시간 합 ms');
  for (const [name, r] of Object.entries(byComp).sort((a, b) => b[1].self - a[1].self).slice(0, opts.top)) {
    lines.push(`${name} | ${r.count} | ${r.commits} | ${r.self.toFixed(1)}`);
  }
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const chrome = await launchChrome(opts.chrome);
  const browser = await Cdp.connect(chrome.wsUrl);
  try {
    const kst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    process.stdout.write(`# ${kst} KST render-profile base=${opts.base}\n`);
    for (let run = 1; run <= opts.runs; run += 1) {
      const log = await profileOnce(browser, opts);
      if (opts.raw) require('node:fs').writeFileSync(opts.raw, JSON.stringify(log));
      process.stdout.write(`${report(log, opts, run)}\n\n`);
    }
  } finally {
    browser.close();
    await chrome.close();
  }
}

main().catch((error) => { process.stderr.write(`오류: ${error && error.stack ? error.stack : error}\n`); process.exitCode = 1; });
