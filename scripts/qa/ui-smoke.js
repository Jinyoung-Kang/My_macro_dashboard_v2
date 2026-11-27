#!/usr/bin/env node
// scripts/qa/ui-smoke.js — 브라우저 연기 시험(의존성 없음 — ui-audit.js의 Chrome·CDP 부분을 씀). QA 스택의 화면을 실제 크롬으로 열어 단언하고,
// 하나라도 어긋나면 0이 아닌 값으로 끝납니다(품질 개선 계획 2026-11-27 §2 P1 — 결정 D-1 지금 도구, D-2 로컬 명령, D-3 가드를 둔 쓰기).
//
// 사용(저장소 최상위에서 — 보통은 `make smoke`):
//   node scripts/qa/ui-smoke.js [--base http://127.0.0.1:13002] [--routes <파일>] [--only <경로 일부>] [--out <폴더>] [--width 1440]
//        [--no-flows | --flows-only] [--strict-flows] [--block '<주소 무늬>,…'] [--settle-max <ms>] [--env-file <.env.qa>] [--chrome <실행 파일>]
//   --base를 주지 않으면 .env.qa의 FRONTEND_PORT로 http://127.0.0.1:<포트>를 씁니다. --routes 기본은 이 파일 옆의 ui-audit-routes.txt.
//   .env.qa는 --env-file → 환경변수 SMOKE_ENV_FILE → 저장소 최상위의 .env.qa 순서로 찾습니다(worktree에서 돌릴 때는 본체 폴더의 파일을 가리킴).
//   --out 기본은 임시 폴더(smoke.json — 콘솔 글 표본이 들어 있으니 커밋하지 않습니다).
//   --block: 그 무늬의 요청을 브라우저 안에서 막습니다(Network.setBlockedURLs) — 음성 대조용(막으면 실패로 끝나야 함).
//
// 1단계 — 화면마다(경로 목록 x 폭 하나) 확인하는 것:
//   문서 200 · 다른 주소로 밀려나지 않음(특히 /login) · 콘솔 오류와 잡히지 않은 예외 0 · 예상 밖 HTTP 400 이상 0 · 네트워크 실패 0 ·
//   오류 경계('화면을 표시하지 못했습니다')와 '찾을 수 없는 화면' 문구 없음 · <main> 안 h1 있음 · 본문이 비지 않음 · 기다림 안에 조용해짐.
//   경로별 예외는 아래 ROUTE_RULES 한 곳에 적습니다(이유와 함께). 값이 맞는지는 보지 않습니다 — 빈 DB의 '—'도 통과입니다.
//   먼저 느린 API를 쓰는 화면(WARM_ROUTES)을 판정 없이 한 번 열어 데우고, 대기 초과일 때만 그 화면을 한 번 다시 엽니다(출력에 남김).
// 2단계 — 흐름(쓰기가 있어 아래 가드를 통과할 때만):
//   (1) 13F 즐겨찾기 상한의 409 문구 (2) QA-1031 (다) 찾기 문구·표지 잔류 (3) QA-1008 쓰기 뒤 다시 읽기 순서 (4) QA-1031 (가) 지운 기관을 고른 채 두지 않음
//   (5) QA-1028 세션이 끝난 뒤 로그아웃 → 로그인 화면(로그인 모드 스택에서만 — 로그인 없는 모드면 '해당 없음').
//   (1)~(4)는 씨앗 scripts/qa/smoke-seed.sql(가짜 CIK 즐겨찾기로 상한 20곳을 채움)이 필요합니다 — 없으면 '건너뜀'(--strict-flows면 실패).
//   흐름은 씨앗 가운데 한 곳의 표시 이름을 고치고 한 곳을 지웁니다 — 씨앗을 다시 넣으면 처음 상태로 돌아옵니다(make smoke가 매번 넣음).
//
// 안전:
//   - 대상은 QA 스택뿐입니다. --base는 이 PC(127.0.0.1·localhost)여야 하고, .env.qa가 있으면 그 FRONTEND_PORT와 포트가 같아야 합니다(아니면 끝 코드 2).
//     로컬 스택(3002)·운영 서버를 대상으로 하지 않습니다(CLAUDE.md).
//   - 쓰기 요청(POST·PUT·PATCH·DELETE)은 브라우저 안에서 모두 막고, 흐름 단계가 그때그때 여는 경로(로그인·로그아웃·가짜 CIK 즐겨찾기)만 통과시킵니다.
//     쓰기를 여는 조건: 포트가 .env.qa의 화면 포트와 같고, 화면의 빌드 정보가 'qa@'로 시작(qa-stack.sh up이 넣는 값)할 것. 로그인만은 빌드 정보를
//     읽기 전이라 포트 조건으로 엽니다(QA 스택의 세션 한 줄).
//   - 로그인 모드 스택이면 .env.qa의 OWNER_EMAIL·APP_PASSWORD로 로그인합니다. 값은 크롬 입력으로만 가고 출력·결과 파일에 적지 않습니다.
//   - 다른 호스트로 가는 요청은 막습니다(ui-audit.js와 같음). 캡처는 찍지 않습니다.
//
// 끝 코드: 0 = 모두 통과, 1 = 어긋난 확인이 있음(또는 스크립트 오류), 2 = 인자·대상 오류.
// 시험: node --test scripts/qa/ui-smoke.test.js (순수 함수 — 인자 해석·판정·가드).
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const audit = require('./ui-audit.js');

const { UsageError } = audit;
const DEFAULT_ENV_FILE = path.join(__dirname, '..', '..', '.env.qa');
const LOOPBACK = new Set(['127.0.0.1', 'localhost']);
const WARM_ROUTES = ['/', '/regime']; // 국면 판정·스냅숏 글 API — 캐시가 식으면 17~20초(ui-audit.js SETTLE 머리)
const MIN_MAIN_TEXT = 20; // 본문 글자 수 하한 — 제목 한 줄만 있는 화면도 넘습니다
const ERROR_SCREEN_TITLE = '화면을 표시하지 못했습니다'; // frontend/src/lib/errorScreen.ts
const NOT_FOUND_TITLE = '찾을 수 없는 화면'; // frontend/src/app/not-found.tsx · (dashboard)/not-found.tsx
const BUILD_TITLE = '실행 중인 코드의 브랜치@커밋'; // components/shell/BuildInfo.tsx
const SEED_PREFIX = '[QA 연기]'; // scripts/qa/smoke-seed.sql의 표시 이름 머리 — 흐름은 이 이름의 즐겨찾기만 고치고 지웁니다
const UNUSED_CIK = '9919999'; // 씨앗에도 SEC에도 없는 가짜 CIK — 상한 409는 SEC 확인보다 먼저 납니다(Sec13FFavoriteService)
const DEFAULT_CIK = '0001067983'; // 13F 화면이 처음 고르는 기관(institutions/page.tsx DEFAULT_CIK)

/**
 * 경로별 예외 — 열쇠는 경로 목록의 글자 그대로. 넣을 때는 이유를 적습니다.
 *   allowHttp: [{ status, path(정규식) }] 그 응답은 예상한 것 · allowConsole: [정규식] 그 콘솔 글은 예상한 것 · redirect: 가도 되는 주소(경로)
 */
const ROUTE_RULES = {};

const USAGE = `사용: node scripts/qa/ui-smoke.js [--base <QA 화면 주소>] [--routes <파일>] [--only <경로 일부>] [--out <폴더>] [--width 1440]
       [--no-flows | --flows-only] [--strict-flows] [--block '<주소 무늬>,…'] [--settle-max <ms>] [--env-file <.env.qa>] [--chrome <실행 파일>]
대상은 QA 스택뿐입니다(로컬 스택·운영 서버 금지). 결과 파일은 커밋하지 마세요.`;

// ------------------------------------------------------------------ 순수 함수(시험 scripts/qa/ui-smoke.test.js)

function parseArgs(argv) {
  const opts = {
    base: null, routes: null, only: null, out: null, width: 1440, flows: 'on', strictFlows: false, block: [],
    settleMax: audit.SETTLE.maxMs, envFile: null, chrome: null, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${arg} 뒤에 값이 필요합니다`);
      i += 1;
      return next;
    };
    switch (arg) {
      case '--base': opts.base = value(); break;
      case '--routes': opts.routes = value(); break;
      case '--only': opts.only = value(); break;
      case '--out': opts.out = value(); break;
      case '--width': {
        const width = Number(value());
        if (!Number.isInteger(width) || width < 280 || width > 3840) throw new UsageError('--width는 280~3840 사이 정수입니다');
        opts.width = width;
        break;
      }
      case '--no-flows': opts.flows = 'off'; break;
      case '--flows-only': opts.flows = 'only'; break;
      case '--strict-flows': opts.strictFlows = true; break;
      case '--block': opts.block = value().split(',').map((part) => part.trim()).filter(Boolean); break;
      case '--settle-max': {
        const ms = Number(value());
        if (!Number.isInteger(ms) || ms < 2000 || ms > 120000) throw new UsageError('--settle-max는 2000~120000 사이 정수(ms)입니다');
        opts.settleMax = ms;
        break;
      }
      case '--env-file': opts.envFile = value(); break;
      case '--chrome': opts.chrome = value(); break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new UsageError(`모르는 인자: ${arg}`);
    }
  }
  if (argv.includes('--no-flows') && argv.includes('--flows-only')) throw new UsageError('--no-flows와 --flows-only는 함께 쓰지 않습니다');
  if (opts.base) {
    let url;
    try { url = new URL(opts.base); } catch { throw new UsageError(`--base 주소가 틀렸습니다: ${opts.base}`); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UsageError('--base는 http(s) 주소입니다');
    opts.base = url.origin + url.pathname.replace(/\/+$/, '');
  }
  return opts;
}

/** .env 꼴 글에서 이 스크립트가 쓰는 세 값만 꺼냅니다(다른 줄은 읽지 않음 — 값은 출력하지 않습니다). */
function parseEnvText(text) {
  const wanted = { FRONTEND_PORT: 'frontendPort', OWNER_EMAIL: 'ownerEmail', APP_PASSWORD: 'appPassword' };
  const out = { frontendPort: null, ownerEmail: null, appPassword: null };
  for (const raw of String(text).split('\n')) {
    const match = raw.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match || !wanted[match[1]] || out[wanted[match[1]]] !== null) continue;
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    out[wanted[match[1]]] = value === '' ? null : value;
  }
  return out;
}

const portOf = (url) => url.port || (url.protocol === 'https:' ? '443' : '80');

/**
 * 대상 정하기 — 이 PC의 QA 스택인지 봅니다. env는 parseEnvText 결과 또는 null(.env.qa 없음).
 * @returns {{ ok: true, base: string, portMatches: boolean } | { ok: false, reason: string }}
 */
function resolveTarget(base, env) {
  const envPort = env && env.frontendPort ? String(env.frontendPort) : null;
  if (!base) {
    if (!envPort) return { ok: false, reason: '--base가 없고 .env.qa에서 FRONTEND_PORT도 읽지 못했습니다' };
    return { ok: true, base: `http://127.0.0.1:${envPort}`, portMatches: true };
  }
  const url = new URL(base);
  if (!LOOPBACK.has(url.hostname)) return { ok: false, reason: `대상은 이 PC의 QA 스택뿐입니다(127.0.0.1·localhost) — ${url.hostname}은 열지 않습니다` };
  if (envPort && portOf(url) !== envPort) {
    return { ok: false, reason: `포트 ${portOf(url)}은 .env.qa의 화면 포트(${envPort})가 아닙니다 — 로컬 스택·다른 스택은 대상이 아닙니다` };
  }
  return { ok: true, base, portMatches: envPort !== null };
}

/** 쓰기 흐름을 돌려도 되는가 — 포트가 .env.qa의 화면 포트와 같고 빌드 정보가 'qa@'로 시작(계획 §2 '설계에서 정한 것'). */
function writeGuard({ portMatches, build }) {
  if (!portMatches) return { ok: false, reason: '.env.qa가 없어 화면 포트를 대조하지 못함' };
  if (!build) return { ok: false, reason: '화면에서 빌드 정보를 읽지 못함(qa-stack.sh up으로 띄운 스택인지 확인)' };
  if (!build.startsWith('qa@')) return { ok: false, reason: "빌드 정보가 'qa@'로 시작하지 않음 — QA 스택이 아님" };
  return { ok: true, reason: null };
}

/** 쓰기 허용 목록 대조 — allowed는 'METHOD 경로' 글자 모음(경로는 질의 없이 정확히 같아야 함). */
function writeAllowed(allowed, method, pathname) {
  return allowed.has(`${String(method).toUpperCase()} ${pathname}`);
}

const routePath = (route) => route.replace(/[?#].*$/, '') || '/';

/**
 * 한 화면의 판정 — 어긋난 확인마다 { check, detail } 한 개(빈 배열이면 통과).
 * @param route 경로 목록의 한 줄
 * @param obs   { error?, docStatus, path, settle('idle'|'timeout'), consoleErrors[], httpErrors[{status, path}], netFailures[{type, error}],
 *               h1[], mainH1, mainText, errorScreen, notFoundScreen }
 * @param rule  ROUTE_RULES의 값 또는 undefined
 */
function judgeRoute(route, obs, rule = {}) {
  if (obs.error) return [{ check: '화면 열기', detail: obs.error }];
  const out = [];
  const add = (check, detail) => out.push({ check, detail });
  if (obs.docStatus !== 200) add('문서 200', `문서 응답 ${obs.docStatus === null || obs.docStatus === undefined ? '없음' : obs.docStatus}`);
  const want = routePath(route);
  if (obs.path !== want && obs.path !== rule.redirect) {
    if (obs.path === '/login') add('로그인 화면으로 밀려나지 않음', '/login으로 감');
    else add('주소 그대로', `${obs.path}(으)로 감`);
  }
  if (obs.settle === 'timeout') add('기다림 안에 조용해짐', '다시 열어도 대기 초과');
  const consoleLeft = (obs.consoleErrors || []).filter((text) => !(rule.allowConsole || []).some((pattern) => pattern.test(text)));
  if (consoleLeft.length) add('콘솔 오류·예외 0', `${consoleLeft.length}건 — ${oneLine(consoleLeft[0], 160)}`);
  const httpLeft = (obs.httpErrors || []).filter((entry) => !(rule.allowHttp || []).some((allow) => allow.status === entry.status && allow.path.test(entry.path)));
  if (httpLeft.length) add('예상 밖 HTTP 400 이상 0', `${httpLeft.length}건 — ${httpLeft.slice(0, 3).map((entry) => `${entry.status} ${entry.path}`).join(', ')}`);
  if ((obs.netFailures || []).length) add('네트워크 실패 0', `${obs.netFailures.length}건 — ${obs.netFailures[0].type || '?'} ${obs.netFailures[0].error || obs.netFailures[0].blockedReason || ''}`.trim());
  if (obs.errorScreen) add('오류 경계 문구 없음', `'${ERROR_SCREEN_TITLE}'이 보임`);
  if (obs.notFoundScreen) add("'찾을 수 없는 화면' 문구 없음", `'${NOT_FOUND_TITLE}'이 보임`);
  if (!obs.mainH1) add('main h1 있음', '<main> 안에 h1이 없음');
  if ((obs.mainText || 0) < MIN_MAIN_TEXT) add('본문이 비지 않음', `본문 글자 ${obs.mainText || 0}자`);
  return out;
}

/**
 * '쓰기 뒤 다시 읽기' 순서(QA-1008) — 쓰기 응답이 끝난 뒤에 나간 readPath의 GET이 있는가. 쓰기 전에 나가 있던 GET에 합류했으면 그런 GET이 없습니다.
 * @param requests [{ method, path, t0, t1, status }] — t0·t1은 같은 시계(CDP timestamp, 초)
 */
function rereadAfterWrite(requests, write, readPath) {
  const done = requests.filter((r) => r.method === write.method && r.path === write.path && typeof r.t1 === 'number').pop();
  if (!done) return { ok: false, detail: `${write.method} ${write.path} 응답을 보지 못함` };
  const reads = requests.filter((r) => r.method === 'GET' && r.path === readPath);
  const after = reads.filter((r) => r.t0 >= done.t1);
  if (!after.length) return { ok: false, detail: `쓰기 뒤에 나간 GET ${readPath}가 없음(같은 경로 GET ${reads.length}건은 모두 쓰기 전에 나감)` };
  if (!after.some((r) => r.status === 200)) return { ok: false, detail: `쓰기 뒤 GET ${readPath}가 200이 아님` };
  return { ok: true, detail: `쓰기 뒤 GET ${after.length}건` };
}

/** 씨앗 표시 이름('[QA 연기] … 9910001')에서 CIK 10자리 — 끝의 숫자를 0으로 채움. 씨앗 이름이 아니면 null. */
function seedCik(label) {
  if (typeof label !== 'string' || !label.startsWith(SEED_PREFIX)) return null;
  const match = label.match(/(\d{1,10})\s*$/);
  return match ? match[1].padStart(10, '0') : null;
}

/**
 * 끝 코드와 요약 수. flows의 state: 'pass' | 'fail' | 'skip'(준비가 안 됨) | 'na'(이 스택에는 해당 없음).
 * 'skip'은 strictFlows일 때만 실패로 셉니다.
 */
function summarize(rows, flows, strictFlows) {
  const failedRoutes = rows.filter((row) => row.violations.length > 0).length;
  const count = (state) => flows.filter((flow) => flow.state === state).length;
  const failedFlows = count('fail') + (strictFlows ? count('skip') : 0);
  return {
    routes: rows.length, passedRoutes: rows.length - failedRoutes, failedRoutes, retried: rows.filter((row) => row.retried).length,
    flows: flows.length, passedFlows: count('pass'), failedFlows, skippedFlows: count('skip'), naFlows: count('na'),
    exitCode: failedRoutes + failedFlows > 0 ? 1 : 0,
  };
}

function oneLine(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

// ------------------------------------------------------------------ 브라우저

// 페이지 안에서 도는 작은 도구 — 보이는 요소를 글로 찾습니다. spec = { sel, text?, mode?('has'|'starts'|'is'), dialog?(대화상자 제목), within?(선택자) }
const IN_PAGE = `
const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
const txt = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
const dialogOf = (title) => [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].find((d) => vis(d) && [...d.querySelectorAll('h1,h2,h3')].some((h) => txt(h) === title)) || null;
const scopeOf = (spec) => { if (spec.dialog) return dialogOf(spec.dialog); if (spec.within) return document.querySelector(spec.within); return document; };
const hit = (spec, el) => { if (spec.text == null) return true; const t = txt(el); return spec.mode === 'is' ? t === spec.text : spec.mode === 'starts' ? t.startsWith(spec.text) : t.includes(spec.text); };
const all = (spec) => { const scope = scopeOf(spec); if (!scope) return []; return [...scope.querySelectorAll(spec.sel)].filter((el) => vis(el) && hit(spec, el)); };
const one = (spec) => { const found = all(spec); if (!spec.row) return found[0] || null; return found.find((el) => { const li = el.closest('li'); return li && txt(li).includes(spec.row); }) || null; };
`;
const inPage = (body) => `(() => { ${IN_PAGE} return (${body}); })()`;

const OBSERVE = inPage(`(() => {
  const main = document.querySelector('main');
  const h1 = [...document.querySelectorAll('h1')].filter(vis).map(txt);
  return {
    path: location.pathname, search: location.search, h1: h1.slice(0, 5),
    mainH1: !!(main && [...main.querySelectorAll('h1')].some(vis)), mainText: main ? txt(main).length : 0,
    errorScreen: h1.includes(${JSON.stringify(ERROR_SCREEN_TITLE)}), notFoundScreen: h1.includes(${JSON.stringify(NOT_FOUND_TITLE)}),
    loginForm: location.pathname === '/login' && !!document.querySelector('input[type="password"]'),
  };
})()`);

/** 한 탭을 모는 얇은 껍데기 — 열기·기다리기·누르기·글 넣기와 요청 기록(흐름의 순서 판정용). */
class Ui {
  constructor(page, opts) {
    this.page = page;
    this.opts = opts;
    this.requests = [];
    this.allowed = new Set();
    this.writesOpen = false;
    this.clock = 0; // 마지막으로 본 CDP 시계 값(초) — '이 뒤에 나간 요청'을 가르는 기준
    const byId = new Map();
    page.on('Network.requestWillBeSent', (p) => {
      let url; try { url = new URL(p.request.url); } catch { return; }
      const entry = { id: p.requestId, method: p.request.method, path: url.pathname, search: url.search, t0: p.timestamp, t1: null, status: null };
      this.clock = Math.max(this.clock, p.timestamp);
      byId.set(p.requestId, entry);
      this.requests.push(entry);
      if (this.requests.length > 4000) this.requests.splice(0, 2000);
    });
    page.on('Network.responseReceived', (p) => { const entry = byId.get(p.requestId); if (entry) entry.status = p.response.status; });
    const end = (p) => { const entry = byId.get(p.requestId); if (entry) entry.t1 = p.timestamp; this.clock = Math.max(this.clock, p.timestamp); byId.delete(p.requestId); };
    page.on('Network.loadingFinished', end);
    page.on('Network.loadingFailed', end);
    page.allowWrite = (method, url) => this.writesOpen && LOOPBACK.has(url.hostname) && writeAllowed(this.allowed, method, url.pathname);
  }

  async open(route) {
    await audit.blank(this.page);
    await audit.setViewport(this.page, this.opts.width);
    this.page.state = this.page.freshState();
    const nav = await this.page.send('Page.navigate', { url: this.opts.base + route }, 30000);
    if (nav.errorText) throw new Error(`이동 실패: ${nav.errorText}`);
    return audit.settle(this.page, this.opts.settleMax);
  }

  eval(body) { return this.page.evaluate(inPage(body), 15000); }

  /** 조건(페이지 안 식)이 참이 될 때까지 — 고정 sleep 없이 0.1초마다 봅니다. */
  async until(label, body, timeoutMs = 15000) {
    const start = Date.now();
    for (;;) {
      let value = null;
      try { value = await this.eval(body); } catch { value = null; }
      if (value) return value;
      if (Date.now() - start >= timeoutMs) throw new Error(`${label}: ${Math.round(timeoutMs / 1000)}초 안에 되지 않음`);
      await audit.sleep(100);
    }
  }

  async click(label, spec) {
    const point = await this.until(`${label} 찾기`, `(() => { const el = one(${JSON.stringify(spec)}); if (!el || el.getAttribute('aria-disabled') === 'true' || el.disabled) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await this.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await this.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await this.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }

  /** 입력칸의 글을 통째로 바꿉니다(포커스 → 전체 선택 → 넣기 — React가 보는 input 이벤트가 납니다). 넣는 글은 어디에도 적지 않습니다. */
  async fill(label, spec, text) {
    await this.until(`${label} 찾기`, `(() => { const el = one(${JSON.stringify(spec)}); if (!el) return false; el.focus(); el.select(); return document.activeElement === el; })()`);
    await this.page.send('Input.insertText', { text });
  }

  /** 끝난 요청 가운데 조건에 맞는 마지막 것이 나올 때까지. since(시계 값) 뒤에 나간 것만 봅니다. */
  async request(label, match, since = 0, timeoutMs = 20000) {
    const start = Date.now();
    for (;;) {
      const found = this.requests.filter((r) => r.t0 >= since && r.t1 !== null && match(r)).pop();
      if (found) return found;
      if (Date.now() - start >= timeoutMs) throw new Error(`${label}: ${Math.round(timeoutMs / 1000)}초 안에 응답이 끝나지 않음`);
      await audit.sleep(100);
    }
  }

  now() { return this.clock; }

  /** 끝난 요청의 응답 본문(JSON) — 읽지 못하면 null. */
  async json(entry) {
    try {
      const got = await this.page.send('Network.getResponseBody', { requestId: entry.id }, 10000);
      return JSON.parse(got.base64Encoded ? Buffer.from(got.body, 'base64').toString('utf8') : got.body);
    } catch { return null; }
  }

  consoleCount() { const st = this.page.state; return st.consoleErrors.length + st.exceptions.length + st.logErrors.length; }
}

async function observe(ui, route) {
  let settleInfo;
  try { settleInfo = await ui.open(route); } catch (error) { return { error: error.message }; }
  const seen = await ui.page.evaluate(OBSERVE, 15000);
  const st = ui.page.state;
  return {
    ...seen, docStatus: st.docStatus, settle: settleInfo.reason, settleMs: settleInfo.ms, openAtEnd: settleInfo.openAtEnd,
    consoleErrors: [...st.consoleErrors, ...st.exceptions, ...st.logErrors], httpErrors: st.httpErrors.slice(), netFailures: st.netFailures.slice(),
    blockedWrites: st.blockedWrites.slice(),
  };
}

/** 로그인 모드 스택이면 .env.qa의 운영자 계정으로 로그인합니다. 돌려주는 값: 'no-login' | 'logged-in'. */
async function ensureSession(ui, env, portMatches) {
  await ui.open('/');
  const seen = await ui.page.evaluate(OBSERVE, 15000);
  if (!seen.loginForm) return 'no-login';
  if (!portMatches || !env || !env.ownerEmail || !env.appPassword) {
    throw new Error('로그인 모드 스택인데 .env.qa에서 운영자 계정을 읽지 못했습니다(--env-file 확인, 또는 QA_NO_LOGIN=1로 띄운 스택에 쓰세요)');
  }
  ui.allowed = new Set(['POST /api/auth/login']);
  ui.writesOpen = true;
  try {
    await ui.fill('이메일 칸', { sel: 'input[type="email"]' }, env.ownerEmail);
    await ui.fill('비밀번호 칸', { sel: 'input[type="password"]' }, env.appPassword);
    await ui.click('로그인 단추', { sel: 'form button[type="submit"]' });
    await ui.until('로그인 뒤 첫 화면', `location.pathname !== '/login'`, 20000);
  } catch (error) {
    throw new Error(`로그인하지 못했습니다 — ${error.message}`);
  } finally {
    ui.writesOpen = false;
    ui.allowed = new Set();
  }
  return 'logged-in';
}

async function readBuild(ui) {
  await ui.open('/more');
  const text = await ui.eval(`(() => { const el = document.querySelector('[title=${JSON.stringify(BUILD_TITLE)}]'); return el ? el.textContent : ''; })()`);
  const match = String(text || '').match(/([^\s·]+@[^\s·]+)/);
  return match ? match[1] : null;
}

// ------------------------------------------------------------------ 흐름

const FAVORITE_FLOWS = [
  '13F 즐겨찾기 상한의 409 문구',
  'QA-1031 (다) 찾기 문구·표지가 남지 않음',
  'QA-1008 쓰기 뒤 다시 읽기 순서',
  'QA-1031 (가) 지운 기관을 고른 채 두지 않음',
];
const LOGOUT_FLOW = 'QA-1028 세션이 끝난 뒤 로그아웃';
const EDIT_DIALOG = '13F 즐겨찾기 편집';
const REMOVE_DIALOG = '즐겨찾기에서 지울까요?';

/**
 * 즐겨찾기 흐름 넷 — 한 대화상자 안에서 차례로. 어긋난 확인은 그 흐름의 실패로 적고 다음 단계로 갑니다(흐름마다 따로 판정).
 * 조작 자체가 안 되면(단추를 못 찾음·응답이 끝나지 않음) 거기서 멈추고, 아직 판정하지 못한 흐름은 '앞 단계 실패'로 적습니다.
 */
async function favoriteFlows(ui) {
  const skipped = new Map(); const failed = new Map(); const passed = new Map();
  const mark = (name, state, detail) => (state === 'skip' ? skipped : passed).set(name, detail || null);
  let current = 0;
  const check = (ok, detail) => { if (!ok && !failed.has(FAVORITE_FLOWS[current])) failed.set(FAVORITE_FLOWS[current], detail); return !!ok; };
  const finish = () => FAVORITE_FLOWS.map((name) => {
    if (skipped.has(name)) return { name, state: 'skip', detail: skipped.get(name) };
    if (failed.has(name)) return { name, state: 'fail', detail: failed.get(name) };
    if (passed.has(name)) return { name, state: 'pass', detail: passed.get(name) };
    return { name, state: 'fail', detail: '앞 단계가 실패해 확인하지 못함' };
  });
  try {
    await ui.open('/institutions');
    const listed = await ui.json(await ui.request('기관 목록', (r) => r.method === 'GET' && r.path === '/api/sec13f/institutions' && r.status === 200));
    const labels = await ui.until('즐겨찾기 목록', `(() => { const g = document.querySelector('[aria-label="즐겨찾기 기관"]'); return g ? { items: [...g.querySelectorAll('[role="radio"]')].filter(vis).map(txt) } : null; })()`);
    const seeds = labels.items.map((label) => ({ label, cik: seedCik(label) })).filter((item) => item.cik);
    if (seeds.length < 2) {
      for (const name of FAVORITE_FLOWS) mark(name, 'skip', `씨앗 즐겨찾기('${SEED_PREFIX} …')가 ${seeds.length}곳 — scripts/qa/smoke-seed.sql을 넣으세요`);
      return finish();
    }
    const [gone, kept] = seeds;
    const favPath = (cik) => `/api/sec13f/favorites/${cik}`;
    ui.writesOpen = true;
    const consoleBefore = ui.consoleCount();

    // 지울 기관을 먼저 골라 둡니다(QA-1031 가의 준비) — 그 기관의 포트폴리오 요청이 나가야 고른 것입니다.
    let since = ui.now();
    await ui.click('지울 즐겨찾기 고르기', { sel: '[aria-label="즐겨찾기 기관"] [role="radio"]', text: gone.label, mode: 'is' });
    await ui.request('고른 기관의 포트폴리오', (r) => r.path === '/api/sec13f/portfolio' && r.search.includes(`cik=${gone.cik}`), since);
    await ui.click('편집 단추', { sel: 'button', text: '편집', mode: 'starts' });
    await ui.until('편집 대화상자', `!!dialogOf(${JSON.stringify(EDIT_DIALOG)})`);
    const inDialog = (spec) => ({ dialog: EDIT_DIALOG, ...spec });
    const statusText = `(() => { const d = dialogOf(${JSON.stringify(EDIT_DIALOG)}); const s = d && d.querySelector('[role="status"][aria-live]'); return s ? txt(s) : ''; })()`;
    const search = async (text) => {
      await ui.fill('찾기 칸', inDialog({ sel: 'form[role="search"] input' }), text);
      await ui.click('찾기 단추', inDialog({ sel: 'form[role="search"] button[type="submit"]' }));
    };

    // (1) 상한 409 문구 — 상한에 찬 상태에서 가짜 CIK를 더하면 서버가 SEC를 부르기 전에 409와 사유를 줍니다.
    const heading = await ui.until('지금 즐겨찾기 수', `(() => { const h = one(${JSON.stringify(inDialog({ sel: 'h3', text: '지금 즐겨찾기', mode: 'starts' }))}); return h ? txt(h) : null; })()`);
    const limit = listed && Number.isInteger(listed.favoriteLimit) ? listed.favoriteLimit : null;
    const have = listed && Array.isArray(listed.favorites) ? listed.favorites.length : null;
    if (!limit || have !== limit) {
      mark(FAVORITE_FLOWS[0], 'skip', `즐겨찾기가 상한에 차지 않음(${heading}${limit ? `, 상한 ${limit}` : ''}) — scripts/qa/smoke-seed.sql을 넣으세요`);
    } else {
      await search(UNUSED_CIK);
      await ui.click('후보 고르기', inDialog({ sel: 'ul[aria-label="찾은 기관"] button', text: '고르기', mode: 'starts' }));
      ui.allowed = new Set(['POST /api/sec13f/favorites']);
      since = ui.now();
      await ui.click('더하기 단추', inDialog({ sel: 'button', text: '즐겨찾기에 더하기', mode: 'starts' }));
      const post = await ui.request('즐겨찾기 더하기', (r) => r.method === 'POST' && r.path === '/api/sec13f/favorites', since, 30000);
      ui.allowed = new Set();
      check(post.status === 409, `POST /api/sec13f/favorites가 409가 아니라 ${post.status}`);
      const said = await ui.until('409 사유 글', statusText);
      check(said.includes(`${limit}곳까지입니다`), `사유 글이 상한 문구가 아님: '${oneLine(said, 80)}'`);
      mark(FAVORITE_FLOWS[0], 'pass', `409 · '${oneLine(said, 60)}'`);
    }

    // (2) 찾기 문구·표지 — 잘못된 입력의 오류 문구가 다음 찾기(CIK)에서 사라지고, 후보 표지는 지금 목록으로 그립니다(뒤쪽 절반은 (4)에서 지운 뒤 봄).
    current = 1;
    await search('한글이름');
    // 앞 단계의 409 글이 아직 남아 있을 수 있어, 이 입력의 사유(한글 이름 — '…영문…')가 나올 때까지 기다립니다.
    const invalid = await ui.until('잘못된 입력 문구', `(() => { const said = ${statusText}; return said.includes('영문') ? said : null; })()`);
    check(await ui.eval(`all(${JSON.stringify(inDialog({ sel: 'ul[aria-label="찾은 기관"]' }))}).length === 0`), '잘못된 입력인데 앞 후보가 남음');
    await search(String(Number(gone.cik)));
    const row = inDialog({ sel: 'ul[aria-label="찾은 기관"] li', text: gone.cik });
    await ui.until('CIK 후보', `all(${JSON.stringify(row)}).length === 1`);
    const leftover = await ui.eval(statusText);
    check(leftover === '', `CIK로 다시 찾았는데 앞 오류 문구가 남음: '${oneLine(leftover, 60)}'(앞 문구 '${oneLine(invalid, 40)}')`);
    check(await ui.eval(`txt(one(${JSON.stringify(row)})).includes('즐겨찾기에 있음')`), "즐겨찾기에 있는 CIK인데 '즐겨찾기에 있음' 표지가 없음");

    // (3) 쓰기 뒤 다시 읽기 — 표시 이름을 고치면 PATCH가 끝난 뒤에 목록 GET이 새로 나가고 새 이름이 보입니다.
    current = 2;
    const renamed = `${SEED_PREFIX} 고친 이름 ${Number(kept.cik)}`;
    await ui.click('고치기 단추', inDialog({ sel: 'button', text: '고치기', mode: 'starts', row: `CIK ${kept.cik}` }));
    await ui.fill('표시 이름 칸', inDialog({ sel: 'form[aria-label$="고치기"] input' }), renamed);
    ui.allowed = new Set([`PATCH ${favPath(kept.cik)}`]);
    since = ui.now();
    await ui.click('저장 단추', inDialog({ sel: 'form[aria-label$="고치기"] button[type="submit"]' }));
    const patch = await ui.request('표시 이름 고치기', (r) => r.method === 'PATCH' && r.path === favPath(kept.cik), since);
    ui.allowed = new Set();
    check(patch.status === 200, `PATCH가 200이 아니라 ${patch.status}`);
    await ui.request('고친 뒤 목록 다시 읽기', (r) => r.method === 'GET' && r.path === '/api/sec13f/institutions' && r.t0 >= patch.t1, since).catch(() => null);
    const reread = rereadAfterWrite(ui.requests.filter((r) => r.t0 >= since), { method: 'PATCH', path: favPath(kept.cik) }, '/api/sec13f/institutions');
    check(reread.ok, reread.detail);
    await ui.until('고친 이름이 목록에 보임', `all(${JSON.stringify(inDialog({ sel: 'li', text: renamed }))}).length > 0`, 10000);
    mark(FAVORITE_FLOWS[2], 'pass', reread.detail);

    // (4) 고른 기관을 지우면 기본 기관으로 — 그리고 (2)의 뒤쪽 절반: 지운 CIK의 후보가 다시 '고르기'가 됩니다.
    current = 3;
    await ui.click('지우기 단추', inDialog({ sel: 'button', text: '지우기', mode: 'starts', row: `CIK ${gone.cik}` }));
    await ui.until('지우기 확인 창', `!!dialogOf(${JSON.stringify(REMOVE_DIALOG)})`);
    ui.allowed = new Set([`DELETE ${favPath(gone.cik)}`]);
    since = ui.now();
    await ui.click('지우기 확인', { dialog: REMOVE_DIALOG, sel: 'button', text: '지우기', mode: 'is' });
    const removed = await ui.request('즐겨찾기 지우기', (r) => r.method === 'DELETE' && r.path === favPath(gone.cik), since);
    ui.allowed = new Set();
    check(removed.status === 200, `DELETE가 200이 아니라 ${removed.status}`);
    await ui.until('확인 창 닫힘', `!dialogOf(${JSON.stringify(REMOVE_DIALOG)})`, 10000);
    const backToDefault = await ui.request('기본 기관의 포트폴리오', (r) => r.path === '/api/sec13f/portfolio' && r.search.includes(`cik=${DEFAULT_CIK}`) && r.t0 >= removed.t1, since, 10000).catch(() => null);
    current = 1;
    const pickable = await ui.until("지운 CIK의 후보가 '고르기'로", `(() => { const li = one(${JSON.stringify(row)}); return li && !txt(li).includes('즐겨찾기에 있음') && [...li.querySelectorAll('button')].some((b) => txt(b).startsWith('고르기')); })()`, 5000).catch(() => false);
    check(pickable, "즐겨찾기를 지웠는데 그 CIK의 후보에 '즐겨찾기에 있음' 표지가 남음");
    mark(FAVORITE_FLOWS[1], 'pass', '오류 문구가 비워지고 표지가 지금 목록을 따름');
    current = 3;
    check(backToDefault !== null, `지운 뒤 기본 기관(CIK ${DEFAULT_CIK})의 포트폴리오 요청이 없음 — 지운 기관을 고른 채 남음`);
    await ui.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await ui.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await ui.until('편집 대화상자 닫힘', `!dialogOf(${JSON.stringify(EDIT_DIALOG)})`, 10000);
    check(!(await ui.eval(`document.body.innerText.includes('추적하는 13F 기관이 아닙니다')`)), "'추적하는 13F 기관이 아닙니다' 안내가 보임");
    check(await ui.eval(`!!one({ sel: '[aria-label="분석할 기관"] [role="radio"][aria-checked="true"]' })`), '기본 기관 목록에 고른 줄이 없음');
    const blocked = ui.page.state.blockedWrites;
    check(blocked.length === 0, `허용하지 않은 쓰기 ${blocked.length}건 — ${blocked.slice(0, 3).map((w) => `${w.method} ${w.path}`).join(', ')}`);
    const consoleNew = ui.consoleCount() - consoleBefore;
    check(consoleNew === 0, `흐름 동안 콘솔 오류·예외 ${consoleNew}건`);
    mark(FAVORITE_FLOWS[3], 'pass', `기본 기관(CIK ${DEFAULT_CIK})으로 돌아감`);
  } catch (error) {
    check(false, error.message);
  } finally {
    ui.writesOpen = false;
    ui.allowed = new Set();
  }
  return finish();
}

/** QA-1028 — 계정 메뉴를 연 채로 세션 쿠키를 지우고(끝난 세션) 로그아웃을 고르면 401을 받고 로그인 화면으로 갑니다. 로그인 모드에서만. */
async function logoutFlow(ui, mode) {
  if (mode !== 'logged-in') return { name: LOGOUT_FLOW, state: 'na', detail: '로그인 없는 모드 스택 — 로그아웃 단추가 없음' };
  try {
    await ui.open('/');
    await ui.click('계정 메뉴', { sel: 'button[aria-label="계정 메뉴"]' });
    await ui.until('로그아웃 항목', `!!one({ sel: '[role="menuitem"]', text: '로그아웃', mode: 'is' })`);
    await ui.page.send('Network.clearBrowserCookies');
    ui.allowed = new Set(['POST /api/auth/logout']);
    ui.writesOpen = true;
    const since = ui.now();
    await ui.click('로그아웃', { sel: '[role="menuitem"]', text: '로그아웃', mode: 'is' });
    const post = await ui.request('로그아웃 요청', (r) => r.method === 'POST' && r.path === '/api/auth/logout', since);
    if (post.status !== 401) return { name: LOGOUT_FLOW, state: 'fail', detail: `끝난 세션의 로그아웃이 401이 아니라 ${post.status}` };
    await ui.until('로그인 화면으로 감', `location.pathname === '/login'`, 10000);
    if (await ui.eval(`document.body.innerText.includes('로그아웃 실패')`)) return { name: LOGOUT_FLOW, state: 'fail', detail: "'로그아웃 실패' 글이 보임" };
    return { name: LOGOUT_FLOW, state: 'pass', detail: '401 뒤 /login으로 감' };
  } catch (error) {
    return { name: LOGOUT_FLOW, state: 'fail', detail: error.message };
  } finally {
    ui.writesOpen = false;
    ui.allowed = new Set();
  }
}

// ------------------------------------------------------------------ 실행

const FLOW_WORD = { pass: '✓', fail: '✗', skip: '건너뜀', na: '해당 없음' };

async function main() {
  let opts; let target; let env = null; let routes = [];
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.help) { process.stdout.write(`${USAGE}\n`); return 0; }
    const envFile = opts.envFile || process.env.SMOKE_ENV_FILE || DEFAULT_ENV_FILE;
    if (fs.existsSync(envFile)) env = parseEnvText(fs.readFileSync(envFile, 'utf8'));
    else if (opts.envFile) throw new UsageError(`--env-file을 찾지 못했습니다: ${opts.envFile}`);
    target = resolveTarget(opts.base, env);
    if (!target.ok) throw new UsageError(target.reason);
    opts.base = target.base;
    if (opts.flows !== 'only') {
      routes = audit.loadRoutes(opts.routes).routes;
      if (opts.only) routes = routes.filter((route) => route.includes(opts.only));
      if (!routes.length) throw new UsageError('고른 경로가 없습니다(--only 확인)');
    }
  } catch (error) {
    if (error instanceof UsageError) { process.stderr.write(`오류: ${error.message}\n${USAGE}\n`); return 2; }
    throw error;
  }
  if (typeof WebSocket !== 'function') { process.stderr.write('오류: 전역 WebSocket이 없습니다 — Node 22 이상이 필요합니다\n'); return 1; }
  const outDir = path.resolve(opts.out || fs.mkdtempSync(path.join(os.tmpdir(), 'ui-smoke-')));
  fs.mkdirSync(outDir, { recursive: true });
  const say = (line) => process.stdout.write(`${line}\n`);
  const started = Date.now();
  say(`# ${audit.kstNow()} KST 연기 시험 base=${opts.base} 폭=${opts.width} 화면=${routes.length}${opts.block.length ? ` 막은 무늬=${opts.block.join(',')}` : ''}`);
  if (!env) say('참고: .env.qa가 없어 화면 포트를 대조하지 못했습니다 — 쓰기 흐름은 돌지 않습니다');

  const chrome = await audit.launchChrome(opts.chrome);
  let cdp = null;
  const stop = () => { if (cdp) cdp.close(); chrome.close().finally(() => process.exit(130)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const rows = []; let flows = []; let mode = null; let build = null;
  try {
    cdp = await audit.Cdp.connect(chrome.wsUrl);
    const page = await audit.openPage(cdp, { base: opts.base, allowExternal: false });
    if (opts.block.length) await page.send('Network.setBlockedURLs', { urls: opts.block });
    const ui = new Ui(page, opts);
    mode = await ensureSession(ui, env, target.portMatches);
    say(`참고: ${mode === 'logged-in' ? '로그인 모드 스택 — .env.qa의 운영자 계정으로 로그인했습니다' : '로그인 없는 모드 스택'}`);

    if (routes.length) {
      for (const route of WARM_ROUTES) { try { await ui.open(route); } catch { /* 데우기 — 판정은 아래에서 */ } }
      for (const route of routes) {
        const t0 = Date.now();
        let obs = await observe(ui, route);
        let retried = false;
        if (!obs.error && obs.settle === 'timeout') { retried = true; obs = await observe(ui, route); }
        const violations = judgeRoute(route, obs, ROUTE_RULES[route]);
        rows.push({ route, ms: Date.now() - t0, retried, violations, obs });
        const tail = `${retried ? ' · 대기 초과로 한 번 다시 엶' : ''}${obs.blockedWrites && obs.blockedWrites.length ? ` · 막은 쓰기 ${obs.blockedWrites.length}` : ''}`;
        if (!violations.length) say(`✓ ${route} (${Date.now() - t0}ms)${tail}`);
        else for (const v of violations) say(`✗ ${route} — ${v.check}: ${v.detail}${tail}`);
      }
    }

    if (opts.flows !== 'off') {
      build = await readBuild(ui);
      const guard = writeGuard({ portMatches: target.portMatches, build });
      if (!guard.ok) {
        flows = [...FAVORITE_FLOWS, LOGOUT_FLOW].map((name) => ({ name, state: 'skip', detail: `쓰기 가드: ${guard.reason}` }));
      } else {
        flows = await favoriteFlows(ui);
        flows.push(await logoutFlow(ui, mode));
      }
      for (const flow of flows) say(`${FLOW_WORD[flow.state]} 흐름 · ${flow.name}${flow.detail ? ` — ${flow.detail}` : ''}`);
    }
  } finally {
    if (cdp) cdp.close();
    await chrome.close();
  }
  const sum = summarize(rows, flows, opts.strictFlows);
  const seconds = Math.round((Date.now() - started) / 1000);
  fs.writeFileSync(path.join(outDir, 'smoke.json'), `${JSON.stringify({ base: opts.base, width: opts.width, mode, build, startedKst: audit.kstNow(), seconds, summary: sum, rows, flows }, null, 2)}\n`);
  say(`끝: 화면 ${sum.routes} · 통과 ${sum.passedRoutes} · 실패 ${sum.failedRoutes} · 다시 연 화면 ${sum.retried} | 흐름 ${sum.flows} · 통과 ${sum.passedFlows} · 실패 ${sum.failedFlows} · 건너뜀 ${sum.skippedFlows} · 해당 없음 ${sum.naFlows} | ${Math.floor(seconds / 60)}분 ${seconds % 60}초 | 결과 ${outDir}/smoke.json(커밋 금지)`);
  return sum.exitCode;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`오류: ${error && error.message ? error.message : error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, parseEnvText, resolveTarget, writeGuard, writeAllowed, judgeRoute, rereadAfterWrite, seedCik, summarize, routePath, ROUTE_RULES };
