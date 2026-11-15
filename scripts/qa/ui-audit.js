#!/usr/bin/env node
// scripts/qa/ui-audit.js — 화면 DOM 감사(의존성 없음). 로컬 headless Chrome을 CDP로 몰아 경로 x 폭마다 화면을 열고 숫자를 잽니다
// (작업대 화면 언어 개편 명세 §9-9, ADR 0042 W11 — 새 시험 의존성 없이 QA 스택에서 개편 전후를 같은 잣대로 비교).
//
// 사용:
//   node scripts/qa/ui-audit.js --base http://127.0.0.1:13002 --routes scripts/qa/ui-audit-routes.txt \
//        --widths 390,1024,1440 --out <결과 폴더> [--shots <캡처 폴더>] [--forced-colors] [--reduced-motion] \
//        [--color-scheme light|dark] [--only <경로 일부>] [--settle-max <ms>] [--chrome <실행 파일>] [--allow-external]
//   node scripts/qa/ui-audit.js --list [--routes <파일>]     → 쓸 경로 목록만 찍고 끝냅니다
//   --routes를 주지 않으면 이 파일 옆의 ui-audit-routes.txt(없으면 홈·매크로·모의매매·정보 검색 네 개)를 씁니다.
//   Node 22 이상(전역 WebSocket·fetch). Chrome은 --chrome → CHROME_PATH → /usr/bin/google-chrome → ~/.cache/ms-playwright의 chromium 순서로
//   찾고, 앞의 것이 뜨지 않으면 다음 것을 씁니다. 사용자 폴더는 임시 폴더(TMPDIR)에 새로 만들고 끝나면 지웁니다.
//
// 재는 것(경로 x 폭마다 JSON 한 개, 끝에 summary.json·summary.md):
//   (a) 보이는 글 가운데 계산된 글자 크기가 12px 미만(SVG 글은 화면 배율을 곱함) — 개수와 표본 10개(글 앞부분·짧은 CSS 경로).
//   (b) 누름 자리(a[href]·button·input·select·textarea·summary·role 단추류·tabindex="0")가 폭 1024 미만에서 44x44, 1024 이상에서 24x24보다 작은 것.
//       문장 속 링크(WCAG 2.5.8 inline 예외 — display:inline이고 같은 블록에 다른 글이 있음)는 따로 셉니다. 화면에서 숨긴 체크박스·라디오는 그 label을 잽니다.
//       disabled·aria-disabled는 세지 않습니다.
//   (c) 가로 넘침: 문서(documentElement.scrollWidth - clientWidth)와, 오른쪽(왼쪽) 끝이 화면 밖인 요소 가운데 가로 스크롤 조상(overflow-x auto|scroll)
//       안이 아닌 것 — 가장 바깥 요소만 세고, overflow-x hidden|clip 조상에 잘리는 것(clipped)과 문서를 넓히는 것(escaping)을 나눕니다.
//   (d) 보이는 글의 계산 대비: 조상의 반투명 바탕을 페이지 바탕 위에 겹쳐 실제 바탕을 셈하고 4.5(큰 글 24px 이상·18.66px 이상 굵게 3)와 비교합니다.
//       바탕 그림·그라디언트 위 글과 SVG fill이 색이 아닌 글은 '모름'으로 따로 셉니다. disabled 조작 안의 글은 세지 않습니다.
//   (e) 참고 지표: 모서리가 9999px 이상이거나 50%인 요소 가운데 정사각형에 가깝지 않은 것(알약 모양)과 4px을 넘는 모서리.
//   (f) 콘솔 오류(console.error·잡히지 않은 예외·네트워크 밖 브라우저 오류). HTTP 4xx·5xx 응답은 따로 셉니다.
//   그 밖에 화면 높이(문서 + 본문 스크롤 상자가 넘친 만큼), 최종 주소(리디렉션), 기다린 시간과 이유를 남깁니다.
//
// 안전:
//   - 주소 이동(GET)만 합니다. 단추를 누르거나 글을 넣지 않습니다. 페이지가 스스로 보내는 GET·HEAD·OPTIONS 밖의 요청(POST·PUT·PATCH·DELETE)은
//     브라우저 안에서 막고(Fetch.failRequest) 결과에 '막은 쓰기'로 적습니다. 기준 주소와 다른 호스트로 가는 요청도 막습니다(--allow-external로 풂).
//   - 캡처(--shots)와 JSON 표본에는 모의 장부 금액·화면 글이 들어 있습니다. 저장소에 커밋하지 말고 작업 폴더(scratchpad 등)에만 두세요.
//     summary.md는 경로별 개수만 적습니다(화면 글 없음).
//   - 로그인 쿠키를 다루지 않습니다 — 로그인 없이 운영자로 여는 QA 스택(QA_NO_LOGIN=1 bash scripts/qa/qa-stack.sh up)에 씁니다.
//
// 끝 코드: 0 = 감사 끝(발견 개수와 무관), 1 = 스크립트 오류(Chrome·CDP 실패, 모든 경로 실패), 2 = 인자 오류.
'use strict';

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_ROUTES_FILE = path.join(__dirname, 'ui-audit-routes.txt');
const FALLBACK_ROUTES = ['/', '/macro', '/paper/us', '/search'];
const DEFAULT_WIDTHS = [390, 1024, 1440];
const MOBILE_BELOW = 1024; // 이 폭 미만은 휴대폰(mobile·터치, 높이 844)
const MOBILE_HEIGHT = 844;
const DESKTOP_HEIGHT = 900;
const SHOT_MAX_HEIGHT = 16384; // 이보다 긴 화면은 위에서부터 이 높이까지만 찍습니다(결과에 표시)
const SAMPLE_MAX = 10;
// 기다림 규칙: 로드 뒤, 셀 수 있는 요청이 0인 채로 1.5초, 불러오는 중 표시(aria-busy·progressbar·pulse·spin) 개수가 1초 그대로,
// 그 표시가 0개이거나 네트워크가 4초 조용함, DOM 변경이 0.5초 없음(12초가 지나면 이 조건은 뺌). 최대 --settle-max(기본 40초 — QA 스택의
// 국면 판정·스냅숏 글 API는 캐시가 식으면 17~20초 넘게 걸렸습니다). 넘으면 그대로 재고 결과에 '대기 초과'와 그때 열린 요청을 적습니다.
// 셀 수 있는 요청 = EventSource·WebSocket(실시간 시세 등 늘 열린 연결) 밖의 모든 요청.
const SETTLE = { netIdleMs: 1500, busyStableMs: 1000, leftoverIdleMs: 4000, domQuietMs: 500, noisyDomAfterMs: 12000, pollMs: 250, maxMs: 40000 };
const LONG_LIVED_TYPES = new Set(['EventSource', 'WebSocket']);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const USAGE = `사용: node scripts/qa/ui-audit.js --base <화면 주소> [--routes <파일>] [--widths 390,1024,1440] [--out <폴더>]
       [--shots <폴더>] [--forced-colors] [--reduced-motion] [--color-scheme light|dark] [--only <경로 일부>]
       [--settle-max <ms>] [--chrome <실행 파일>] [--allow-external]
       node scripts/qa/ui-audit.js --list [--routes <파일>]
캡처와 JSON 표본에는 화면 글(모의 장부 금액 포함)이 들어 있습니다 — 저장소에 커밋하지 마세요.`;

class UsageError extends Error {}

// ------------------------------------------------------------------ 인자

function parseArgs(argv) {
  const opts = {
    base: null, routes: null, out: null, shots: null, widths: DEFAULT_WIDTHS, forcedColors: false, reducedMotion: false,
    colorScheme: null, list: false, only: null, chrome: null, settleMax: SETTLE.maxMs, allowExternal: false, help: false,
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
      case '--out': opts.out = value(); break;
      case '--shots': opts.shots = value(); break;
      case '--widths': opts.widths = parseWidths(value()); break;
      case '--forced-colors': opts.forcedColors = true; break;
      case '--reduced-motion': opts.reducedMotion = true; break;
      case '--color-scheme': {
        const scheme = value();
        if (scheme !== 'light' && scheme !== 'dark') throw new UsageError('--color-scheme은 light 또는 dark입니다');
        opts.colorScheme = scheme;
        break;
      }
      case '--only': opts.only = value(); break;
      case '--settle-max': {
        const ms = Number(value());
        if (!Number.isInteger(ms) || ms < 2000 || ms > 120000) throw new UsageError('--settle-max는 2000~120000 사이 정수(ms)입니다');
        opts.settleMax = ms;
        break;
      }
      case '--chrome': opts.chrome = value(); break;
      case '--allow-external': opts.allowExternal = true; break;
      case '--list': opts.list = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new UsageError(`모르는 인자: ${arg}`);
    }
  }
  if (opts.base) {
    let url;
    try { url = new URL(opts.base); } catch { throw new UsageError(`--base 주소가 틀렸습니다: ${opts.base}`); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UsageError('--base는 http(s) 주소입니다');
    opts.base = url.origin + url.pathname.replace(/\/+$/, '');
  }
  return opts;
}

function parseWidths(text) {
  const widths = text.split(',').map((part) => Number(part.trim()));
  if (!widths.length || widths.some((w) => !Number.isInteger(w) || w < 280 || w > 3840)) {
    throw new UsageError('--widths는 280~3840 사이 정수를 쉼표로 이은 목록입니다(예: 390,1024,1440)');
  }
  return widths;
}

/** 경로 목록 — 한 줄에 경로 하나, '#' 뒤는 주석, 빈 줄은 건너뜀. 경로는 '/'로 시작해야 합니다. */
function loadRoutes(file) {
  const source = file || (fs.existsSync(DEFAULT_ROUTES_FILE) ? DEFAULT_ROUTES_FILE : null);
  if (!source) return { file: null, routes: FALLBACK_ROUTES.slice() };
  const routes = [];
  fs.readFileSync(source, 'utf8').split('\n').forEach((raw, index) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    if (!line.startsWith('/') || /\s/.test(line)) throw new UsageError(`${source}:${index + 1} 경로는 '/'로 시작하고 공백이 없어야 합니다: ${line}`);
    routes.push(line);
  });
  if (!routes.length) throw new UsageError(`${source}에 경로가 없습니다`);
  return { file: source, routes };
}

// ------------------------------------------------------------------ Chrome

function chromeCandidates(explicit) {
  const list = [];
  if (explicit) list.push(explicit);
  if (process.env.CHROME_PATH) list.push(process.env.CHROME_PATH);
  list.push('/usr/bin/google-chrome');
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    const dirs = fs.readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const dir of dirs) {
      for (const sub of ['chrome-linux64', 'chrome-linux']) list.push(path.join(cache, dir, sub, 'chrome'));
    }
  } catch { /* 캐시 폴더 없음 */ }
  return [...new Set(list)].filter((file) => fs.existsSync(file));
}

function launchOne(executable, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-audit-chrome-'));
    const args = [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDir}`, '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
      '--mute-audio', '--hide-scrollbars', '--lang=ko-KR', '--password-store=basic', '--use-mock-keychain', 'about:blank',
    ];
    // Chrome은 TMPDIR 아래에 단일 실행 소켓을 만들고, 그 경로가 소켓 주소 한도(108바이트)를 넘으면 시작하자마자 죽습니다 —
    // 긴 TMPDIR(작업 폴더 등)이면 Chrome에게만 TMPDIR을 빼서 시스템 기본 임시 폴더를 쓰게 합니다(사용자 폴더는 그대로 TMPDIR 아래).
    const env = { ...process.env };
    if (env.TMPDIR && env.TMPDIR.length > 60) delete env.TMPDIR;
    const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], env });
    let settled = false;
    let stderr = '';
    // Chrome의 보조 프로세스가 본 프로세스보다 늦게 끝나며 폴더를 다시 만들 수 있어, 조금 기다렸다가 다시 지웁니다.
    const cleanupDir = async () => {
      for (let attempt = 0; attempt < 3 && fs.existsSync(userDir); attempt += 1) {
        await sleep(500);
        try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 다음 차례에 다시 */ }
      }
    };
    const close = async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const exited = await new Promise((done) => {
          const timer = setTimeout(() => done(false), 4000);
          child.once('exit', () => { clearTimeout(timer); done(true); });
        });
        if (!exited) child.kill('SIGKILL');
      }
      await cleanupDir();
    };
    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      close().finally(() => reject(new Error(message)));
    };
    const timer = setTimeout(() => fail(`${executable}: ${timeoutMs}ms 안에 DevTools 주소가 나오지 않았습니다 ${stderr.slice(-300)}`), timeoutMs);
    child.on('error', (error) => fail(`${executable}: 실행 실패 ${error.message}`));
    child.on('exit', (code) => fail(`${executable}: 시작 중 끝남(코드 ${code}) ${stderr.slice(-300)}`));
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        child.removeAllListeners('exit');
        resolve({ executable, wsUrl: match[1], close });
      }
    });
  });
}

async function launchChrome(explicit) {
  const candidates = chromeCandidates(explicit);
  if (!candidates.length) throw new Error('Chrome을 찾지 못했습니다(--chrome 또는 CHROME_PATH로 주세요)');
  const errors = [];
  for (const executable of candidates) {
    try {
      return await launchOne(executable);
    } catch (error) {
      errors.push(error.message);
      process.stderr.write(`참고: ${error.message.split('\n')[0]} — 다음 후보로 넘어갑니다\n`);
    }
  }
  throw new Error(`Chrome을 띄우지 못했습니다:\n${errors.join('\n')}`);
}

// ------------------------------------------------------------------ CDP

class Cdp {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error(`CDP 연결 실패: ${url}`)), { once: true });
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    ws.addEventListener('message', (event) => this.onMessage(event));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP 연결이 끊겼습니다'));
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 60000) {
    if (this.closed) return Promise.reject(new Error('CDP 연결이 끊겼습니다'));
    this.nextId += 1;
    const id = this.nextId;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: ${timeoutMs}ms 안에 답이 없습니다`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.ws.send(JSON.stringify(message));
    });
  }

  on(method, sessionId, handler) {
    const key = `${sessionId || ''}|${method}`;
    if (!this.listeners.has(key)) this.listeners.set(key, []);
    this.listeners.get(key).push(handler);
  }

  onMessage(event) {
    let message;
    try { message = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString()); } catch { return; }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${message.error.message}${message.error.data ? ` (${message.error.data})` : ''}`));
      else entry.resolve(message.result);
      return;
    }
    const handlers = this.listeners.get(`${message.sessionId || ''}|${message.method}`);
    if (handlers) {
      for (const handler of handlers) {
        try { handler(message.params || {}); } catch (error) { process.stderr.write(`경고: ${message.method} 처리 중 오류 ${error.message}\n`); }
      }
    }
  }

  close() {
    try { this.ws.close(); } catch { /* 이미 닫힘 */ }
  }
}

/** 한 탭(page target)과 그 탭의 네트워크·콘솔 기록. */
class PageSession {
  constructor(cdp, sessionId, allowHosts) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.allowHosts = allowHosts; // null이면 모든 호스트 허용
    this.state = this.freshState();
    this.wire();
  }

  freshState() {
    return {
      loadFired: false, inflight: new Map(), lastNetActivity: Date.now(), docStatus: null, mainRequestId: null,
      consoleErrors: [], exceptions: [], logErrors: [], httpErrors: [], netFailures: [],
      blockedWrites: [], blockedExternal: new Map(), blockedNetworkIds: new Set(),
    };
  }

  send(method, params = {}, timeoutMs = 60000) {
    return this.cdp.send(method, params, this.sessionId, timeoutMs);
  }

  on(method, handler) {
    this.cdp.on(method, this.sessionId, handler);
  }

  wire() {
    const st = () => this.state;
    this.on('Page.loadEventFired', () => { st().loadFired = true; });
    this.on('Page.javascriptDialogOpening', () => { this.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {}); });
    this.on('Network.requestWillBeSent', (p) => {
      const s = st();
      s.inflight.set(p.requestId, { type: p.type || 'Other', t: Date.now(), path: pathOf(p.request.url) });
      s.lastNetActivity = Date.now();
      if (p.type === 'Document' && !s.mainRequestId) s.mainRequestId = p.requestId;
    });
    this.on('Network.responseReceived', (p) => {
      const s = st();
      if (p.requestId === s.mainRequestId) s.docStatus = p.response.status;
      if (p.response.status >= 400) s.httpErrors.push({ status: p.response.status, type: p.type, path: pathOf(p.response.url) });
    });
    const finish = (p) => {
      const s = st();
      s.inflight.delete(p.requestId);
      s.lastNetActivity = Date.now();
    };
    this.on('Network.loadingFinished', finish);
    this.on('Network.loadingFailed', (p) => {
      finish(p);
      const s = st();
      if (p.canceled || s.blockedNetworkIds.has(p.requestId)) return;
      s.netFailures.push({ type: p.type, error: p.errorText, blockedReason: p.blockedReason || null });
    });
    this.on('Fetch.requestPaused', (p) => this.onRequestPaused(p));
    this.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error' && p.type !== 'assert') return;
      const text = (p.args || []).map((arg) => arg.value !== undefined ? String(arg.value) : (arg.description || arg.type)).join(' ');
      st().consoleErrors.push(clip(text, 300));
    });
    this.on('Runtime.exceptionThrown', (p) => {
      const detail = p.exceptionDetails || {};
      st().exceptions.push(clip((detail.exception && detail.exception.description) || detail.text || '예외', 300));
    });
    this.on('Log.entryAdded', (p) => {
      const entry = p.entry || {};
      if (entry.level !== 'error' || entry.source === 'network') return; // 네트워크 오류는 httpErrors·netFailures가 셈
      st().logErrors.push(clip(`[${entry.source}] ${entry.text || ''}`, 300));
    });
  }

  onRequestPaused(p) {
    const s = this.state;
    const method = (p.request && p.request.method) || 'GET';
    let url;
    try { url = new URL(p.request.url); } catch { url = null; }
    if (!READ_METHODS.has(method)) {
      if (p.networkId) s.blockedNetworkIds.add(p.networkId);
      s.blockedWrites.push({ method, path: url ? url.pathname : '?' });
      this.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      return;
    }
    if (url && this.allowHosts && (url.protocol === 'http:' || url.protocol === 'https:') && !this.allowHosts.has(url.hostname)) {
      if (p.networkId) s.blockedNetworkIds.add(p.networkId);
      s.blockedExternal.set(url.hostname, (s.blockedExternal.get(url.hostname) || 0) + 1);
      this.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      return;
    }
    this.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
  }

  countInflight(now) {
    let count = 0;
    for (const request of this.state.inflight.values()) {
      if (LONG_LIVED_TYPES.has(request.type)) continue;
      count += 1;
    }
    return count;
  }

  /** 아직 열린 요청(긴 연결 포함) — 기다림이 끝날 때 무엇이 남았는지 결과에 적습니다. */
  openRequests(now) {
    return [...this.state.inflight.values()].slice(0, SAMPLE_MAX).map((request) => ({ type: request.type, path: request.path, ms: now - request.t }));
  }

  async evaluate(expression, timeoutMs = 60000) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(`페이지 안 실행 오류: ${(detail.exception && detail.exception.description) || detail.text}`);
    }
    return result.result.value;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}...` : text);
function pathOf(raw) {
  try { const url = new URL(raw); return url.pathname; } catch { return '?'; }
}

// 문서가 만들어질 때마다(페이지 스크립트보다 먼저) DOM 변경 시각을 적는 관찰자를 답니다 — 기다림 규칙의 'DOM 변경 없음'.
const MUTATION_TRACKER = `(() => { try {
  window.__uiAuditLastMutation = performance.now();
  new MutationObserver(() => { window.__uiAuditLastMutation = performance.now(); })
    .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
} catch (e) { /* 관찰자를 달지 못하면 DOM 조건은 시간으로만 */ } })()`;

const PROBE = `(() => {
  let busy = 0;
  for (const el of document.querySelectorAll('[aria-busy="true"],[role="progressbar"],[class*="animate-pulse"],[class*="animate-spin"]')) {
    if (el.getClientRects().length) busy += 1;
  }
  const last = typeof window.__uiAuditLastMutation === 'number' ? window.__uiAuditLastMutation : 0;
  return { busy, domQuietMs: performance.now() - last, ready: document.readyState };
})()`;

async function settle(page, maxMs) {
  const start = Date.now();
  let lastBusy = null;
  let busyChangedAt = start;
  for (;;) {
    const now = Date.now();
    const elapsed = now - start;
    let probe = null;
    try { probe = await page.evaluate(PROBE, 5000); } catch { probe = null; }
    const busy = probe ? probe.busy : -1;
    if (busy !== lastBusy) { lastBusy = busy; busyChangedAt = now; }
    const inflight = page.countInflight(now);
    const netIdle = inflight === 0 ? now - page.state.lastNetActivity : 0;
    const ok = page.state.loadFired && probe && probe.ready === 'complete' && inflight === 0
      && netIdle >= SETTLE.netIdleMs && now - busyChangedAt >= SETTLE.busyStableMs
      && (busy === 0 || netIdle >= SETTLE.leftoverIdleMs)
      && (probe.domQuietMs >= SETTLE.domQuietMs || elapsed >= SETTLE.noisyDomAfterMs);
    if (ok) return { reason: 'idle', ms: elapsed, busyAtEnd: busy, inflightAtEnd: 0, openAtEnd: page.openRequests(now) };
    if (elapsed >= maxMs) {
      return { reason: 'timeout', ms: elapsed, busyAtEnd: busy, inflightAtEnd: inflight, loadFired: page.state.loadFired, openAtEnd: page.openRequests(now) };
    }
    await sleep(SETTLE.pollMs);
  }
}

// ------------------------------------------------------------------ 페이지 안 감사(이 함수는 문자열로 페이지에 넘어가 그 안에서 돕니다 — 바깥 변수를 쓰지 않음)

function pageAudit(opts) {
  const MAX = opts.sampleMax;
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const targetMin = opts.viewportWidth < opts.mobileBelow ? 44 : 24;
  const styleMemo = new Map();
  const cs = (el) => {
    let style = styleMemo.get(el);
    if (!style) { style = getComputedStyle(el); styleMemo.set(el, style); }
    return style;
  };
  const round1 = (n) => Math.round(n * 10) / 10;
  const snippet = (text) => {
    const clean = (text || '').replace(/\s+/g, ' ').trim();
    return clean.length > 40 ? `${clean.slice(0, 40)}...` : clean;
  };
  function cssPath(el) {
    const parts = [];
    for (let node = el, depth = 0; node && node.nodeType === 1 && node !== document.body && depth < 4; node = node.parentElement, depth += 1) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(`${part}#${node.id}`); break; }
      const classes = (node.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).map((name) => (name.length > 28 ? name.slice(0, 28) : name));
      if (classes.length) part += `.${classes.join('.')}`;
      const role = node.getAttribute('role');
      if (role) part += `[role=${role}]`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  }
  function put(bag, key, sample) {
    const current = bag.get(key);
    if (current) current.n += 1;
    else bag.set(key, Object.assign({ n: 1 }, sample));
  }
  const topOf = (bag, compare) => [...bag.values()].sort(compare).slice(0, MAX);
  const bump = (counter, key) => { counter[key] = (counter[key] || 0) + 1; };

  // 숨김 — 투명도 0, sr-only(clip-path inset(50%)·clip rect(0 0 0 0)·1px 이하로 잘림)인 조상 아래는 화면에 없는 것으로 봅니다.
  const hiddenMemo = new Map();
  function clipsAll(el) {
    const s = cs(el);
    if (s.opacity === '0') return true;
    if (/^inset\(\s*50%/.test(s.clipPath || '')) return true;
    if (/^rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)$/.test(s.clip || '')) return true;
    if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 && r.height <= 1) return true;
    }
    return false;
  }
  function hiddenByTree(el) {
    if (!el || el.nodeType !== 1) return false;
    if (hiddenMemo.has(el)) return hiddenMemo.get(el);
    const value = clipsAll(el) || hiddenByTree(el.parentElement);
    hiddenMemo.set(el, value);
    return value;
  }
  function visible(el) {
    if (!el.getClientRects().length) return false;
    if (cs(el).visibility !== 'visible') return false;
    if (el.closest('[inert]')) return false;
    return !hiddenByTree(el);
  }

  // 색 — 계산값(rgb·oklab·color-mix 결과 등)을 1px 캔버스에 칠해 sRGB로 읽습니다.
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const colorMemo = new Map();
  function parseColor(text) {
    if (!text) return null;
    if (colorMemo.has(text)) return colorMemo.get(text);
    let color = null;
    const m = text.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
    if (m) {
      const alpha = m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
      color = { r: +m[1], g: +m[2], b: +m[3], a: alpha };
    } else if (text === 'transparent') {
      color = { r: 0, g: 0, b: 0, a: 0 };
    } else {
      ctx.fillStyle = '#010203';
      ctx.fillStyle = text;
      if (ctx.fillStyle !== '#010203' || text === '#010203') {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        color = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
      }
    }
    colorMemo.set(text, color);
    return color;
  }
  const blend = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1,
  });
  const hex = (c) => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  const lum = (c) => {
    const f = (v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const contrastRatio = (a, b) => {
    const la = lum(a);
    const lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const rootScheme = cs(doc).colorScheme || '';
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const darkCanvas = /dark/.test(rootScheme) && (!/light/.test(rootScheme) || prefersDark);
  const BASE = darkCanvas ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  const UNKNOWN = { unknown: true };
  const bgMemo = new Map();
  function backgroundOf(el) {
    if (!el) return BASE;
    if (bgMemo.has(el)) return bgMemo.get(el);
    const parent = el.parentElement ? backgroundOf(el.parentElement) : BASE;
    const s = cs(el);
    const color = parseColor(s.backgroundColor) || { r: 0, g: 0, b: 0, a: 0 };
    let result;
    if (s.backgroundImage && s.backgroundImage !== 'none') result = UNKNOWN;
    else if (color.a >= 0.999) result = color;
    else if (color.a <= 0.001 || parent === UNKNOWN) result = parent;
    else result = blend(color, parent);
    bgMemo.set(el, result);
    return result;
  }
  const opacityMemo = new Map();
  function opacityOf(el) {
    if (!el || el.nodeType !== 1) return 1;
    if (opacityMemo.has(el)) return opacityMemo.get(el);
    const own = parseFloat(cs(el).opacity);
    const value = (Number.isFinite(own) ? own : 1) * opacityOf(el.parentElement);
    opacityMemo.set(el, value);
    return value;
  }

  // ---- 글 묶음(직접 글을 가진 요소마다 하나)
  const groups = new Map();
  const range = document.createRange();
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'OPTION']);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue;
    if (!text || !text.trim()) continue;
    const el = node.parentElement;
    if (!el || SKIP.has(el.tagName)) continue;
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const group = groups.get(el);
    if (group) group.text += text;
    else groups.set(el, { text });
  }

  const small = { count: 0, bySize: {}, bag: new Map() };
  const contrast = { checked: 0, fail: 0, unknown: 0, disabledSkipped: 0, invisibleSkipped: 0, bag: new Map(), pairs: new Map(), unknownBag: new Map() };
  const DISABLED = 'button:disabled, input:disabled, select:disabled, textarea:disabled, fieldset:disabled, [aria-disabled="true"]';
  let textElements = 0;
  for (const [el, group] of groups) {
    if (!visible(el)) continue;
    textElements += 1;
    const s = cs(el);
    const isSvg = el instanceof SVGElement;
    let px = parseFloat(s.fontSize) || 0;
    if (isSvg && el.getScreenCTM) {
      const m = el.getScreenCTM();
      if (m) px *= Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
    }
    px = round1(px);
    const text = snippet(group.text);
    const where = cssPath(el);
    // (a) 12px 미만
    if (px < 12) {
      small.count += 1;
      bump(small.bySize, String(px));
      put(small.bag, `${px}|${text}|${where}`, { px, text, path: where, svg: isSvg || undefined });
    }
    // (d) 대비
    if (el.closest(DISABLED)) { contrast.disabledSkipped += 1; continue; }
    // -webkit-text-fill-color는 보지 않습니다 — 강제 색 모드에서 color는 시스템 색으로 바뀌어도 이 값은 작성자 색 그대로 남아(실제 그림과 다름) 틀린 미달을 냈습니다.
    const fgText = isSvg ? s.fill : s.color;
    const bg = backgroundOf(el);
    const fg = parseColor(fgText);
    let unknownReason = null;
    if (bg === UNKNOWN) unknownReason = '바탕 그림·그라디언트';
    else if (s.backgroundClip === 'text' || s.webkitBackgroundClip === 'text') unknownReason = '글자 바탕 잘라내기';
    else if (!fg) unknownReason = isSvg ? 'SVG fill이 색이 아님' : '글자 색을 읽지 못함';
    if (unknownReason) {
      contrast.unknown += 1;
      put(contrast.unknownBag, `${unknownReason}|${where}`, { reason: unknownReason, text, path: where });
      continue;
    }
    const alpha = fg.a * opacityOf(el);
    if (alpha < 0.05) { contrast.invisibleSkipped += 1; continue; }
    const effective = blend({ r: fg.r, g: fg.g, b: fg.b, a: alpha }, bg);
    const ratio = Math.round(contrastRatio(effective, bg) * 100) / 100;
    const weight = parseInt(s.fontWeight, 10) || 400;
    const large = px >= 24 || (px >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    contrast.checked += 1;
    if (ratio < need) {
      contrast.fail += 1;
      const pair = `${hex(effective)} on ${hex(bg)}`;
      put(contrast.pairs, pair, { fg: hex(effective), bg: hex(bg), ratio, need });
      put(contrast.bag, `${ratio}|${text}|${where}`, { ratio, need, px, fg: hex(effective), bg: hex(bg), text, path: where });
    }
  }

  // ---- (b) 누름 자리
  const TARGETS = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], '
    + '[role="checkbox"], [role="switch"], [role="radio"], [role="option"], [role="menuitem"], [role="treeitem"], [tabindex="0"]';
  const targets = { min: targetMin, checked: 0, small: 0, inline: 0, disabledSkipped: 0, byKind: {}, bag: new Map(), inlineBag: new Map() };
  const kindOf = (el) => {
    const role = el.getAttribute('role');
    if (role) return `[role=${role}]`;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') return `input[${el.type}]`;
    if (tag === 'a' || tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary') return tag;
    return `${tag}[tabindex]`;
  };
  function inlineLink(el) {
    if (!(el.tagName === 'A' || el.getAttribute('role') === 'link')) return false;
    if (cs(el).display !== 'inline') return false;
    let block = el.parentElement;
    while (block && (cs(block).display === 'inline' || cs(block).display === 'contents')) block = block.parentElement;
    if (!block) return false;
    const all = (block.textContent || '').replace(/\s+/g, '');
    const own = (el.textContent || '').replace(/\s+/g, '');
    return all.length > own.length;
  }
  for (const el of document.querySelectorAll(TARGETS)) {
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') { targets.disabledSkipped += 1; continue; }
    let box = el;
    const shown = visible(el);
    if (!shown || el.getBoundingClientRect().width < 1) {
      // 화면에서 숨긴 체크박스·라디오(sr-only)는 그 label이 누름 자리입니다.
      if (el.tagName !== 'INPUT') continue;
      const label = (el.labels && el.labels[0]) || el.closest('label');
      if (!label || !visible(label)) continue;
      box = label;
    }
    const r = box.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    targets.checked += 1;
    const w = round1(r.width);
    const h = round1(r.height);
    if (w >= targetMin && h >= targetMin) continue;
    const kind = kindOf(el);
    const label = snippet(el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.getAttribute('name') || '');
    const sample = { kind, w, h, text: label, path: cssPath(el), viaLabel: box !== el || undefined };
    if (inlineLink(el)) {
      targets.inline += 1;
      put(targets.inlineBag, `${kind}|${w}x${h}|${label}`, sample);
    } else {
      targets.small += 1;
      bump(targets.byKind, kind);
      put(targets.bag, `${kind}|${w}x${h}|${label}|${sample.path}`, sample);
    }
  }

  // ---- (c) 가로 넘침과 (e) 모서리 — 보이는 요소 전부(SVG 안쪽은 건너뜀)
  const overflow = {
    page: Math.max(0, doc.scrollWidth - vw), scrollWidth: doc.scrollWidth, clientWidth: vw, innerWidth: window.innerWidth,
    count: 0, escaping: 0, clipped: 0, bag: new Map(),
  };
  const flagged = new Set();
  // 본문 스크롤 상자 — lg 이상 셸은 문서가 아니라 <main>이 세로로 스크롤해 문서 높이가 창 높이와 같습니다. 문서가 스크롤하지 않을 때만,
  // 창 높이의 절반·창 폭의 절반 이상이고 세로로 넘친 상자 가운데 가장 긴 것을 본문으로 보고 그 넘친 만큼을 더한 값을 화면 높이(contentHeight)로 적습니다.
  const docScrolls = doc.scrollHeight > window.innerHeight + 1;
  let pageScroller = null;
  const shape = { pills: 0, pillsPainted: 0, circles: 0, roundedOver4: 0, pillByKind: {}, radiusOver4: {}, bag: new Map() };
  const isFull = (value) => {
    if (!value) return false;
    if (value.includes('%')) return parseFloat(value) >= 50;
    return parseFloat(value) >= 9999;
  };
  for (const el of document.body.querySelectorAll('*')) {
    if (el instanceof SVGElement && el.tagName.toLowerCase() !== 'svg') continue;
    if (!el.getClientRects().length) continue;
    const s = cs(el);
    if (s.visibility !== 'visible') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (hiddenByTree(el)) continue;
    if (!docScrolls && (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.clientHeight >= window.innerHeight * 0.5 && el.clientWidth >= vw * 0.5
      && el.scrollHeight > el.clientHeight + 1 && (!pageScroller || el.scrollHeight > pageScroller.scrollHeight)) pageScroller = el;
    // (e)
    const corners = [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius];
    if (isFull(corners[0]) && isFull(corners[2])) {
      const aspect = r.width / r.height;
      if (aspect >= 0.8 && aspect <= 1.25) {
        shape.circles += 1;
      } else {
        shape.pills += 1;
        const bgColor = parseColor(s.backgroundColor);
        const painted = (bgColor && bgColor.a > 0) || parseFloat(s.borderTopWidth) > 0 || s.boxShadow !== 'none' || (s.backgroundImage && s.backgroundImage !== 'none');
        if (painted) shape.pillsPainted += 1;
        const kind = el.tagName.toLowerCase();
        bump(shape.pillByKind, kind);
        put(shape.bag, `${kind}|${snippet(el.textContent)}|${cssPath(el)}`, { kind, w: round1(r.width), h: round1(r.height), painted, text: snippet(el.textContent), path: cssPath(el) });
      }
    } else {
      const radius = Math.max(...corners.map((value) => (value && !value.includes('%') ? parseFloat(value) || 0 : 0)));
      if (radius > 4.5) {
        shape.roundedOver4 += 1;
        bump(shape.radiusOver4, `${round1(radius)}px`);
      }
    }
    // (c)
    if (r.right > vw + 1 || r.left < -1) {
      let inside = false;
      for (let anc = el.parentElement; anc && anc !== document.body; anc = anc.parentElement) {
        if (flagged.has(anc)) { inside = true; break; }
      }
      if (inside) continue;
      let scroller = null;
      let clipper = null;
      if (s.position !== 'fixed') {
        for (let anc = el.parentElement; anc && anc !== doc; anc = anc.parentElement) {
          const ox = cs(anc).overflowX;
          if (ox === 'auto' || ox === 'scroll') { scroller = anc; break; }
          if (ox === 'hidden' || ox === 'clip') { clipper = anc; break; }
        }
      }
      if (scroller) continue;
      flagged.add(el);
      overflow.count += 1;
      if (clipper) overflow.clipped += 1;
      else overflow.escaping += 1;
      const where = cssPath(el);
      put(overflow.bag, where, {
        left: round1(r.left), right: round1(r.right), width: round1(r.width), text: snippet(el.textContent), path: where,
        clippedBy: clipper ? cssPath(clipper) : null, fixed: s.position === 'fixed' || undefined,
      });
    }
  }

  const main = document.querySelector('main');
  const h1 = document.querySelector('h1');
  return {
    url: location.href,
    path: location.pathname + location.search,
    title: document.title,
    h1: h1 ? snippet(h1.textContent) : null,
    viewport: { width: vw, innerWidth: window.innerWidth, height: window.innerHeight, targetMin },
    docHeight: doc.scrollHeight,
    contentHeight: doc.scrollHeight + (pageScroller ? pageScroller.scrollHeight - pageScroller.clientHeight : 0),
    pageScroller: pageScroller ? cssPath(pageScroller) : null,
    mainTop: main ? round1(main.getBoundingClientRect().top + window.scrollY) : null,
    textElements,
    smallText: { count: small.count, bySize: small.bySize, distinct: small.bag.size, samples: topOf(small.bag, (a, b) => a.px - b.px || b.n - a.n) },
    targets: {
      min: targets.min, checked: targets.checked, small: targets.small, inline: targets.inline, disabledSkipped: targets.disabledSkipped,
      byKind: targets.byKind,
      samples: topOf(targets.bag, (a, b) => Math.min(a.w, a.h) - Math.min(b.w, b.h) || b.n - a.n),
      inlineSamples: topOf(targets.inlineBag, (a, b) => b.n - a.n),
    },
    overflow: {
      page: overflow.page, scrollWidth: overflow.scrollWidth, clientWidth: overflow.clientWidth, innerWidth: overflow.innerWidth,
      count: overflow.count, escaping: overflow.escaping, clipped: overflow.clipped,
      samples: topOf(overflow.bag, (a, b) => b.right - a.right),
    },
    contrast: {
      base: hex(BASE), checked: contrast.checked, fail: contrast.fail, unknown: contrast.unknown,
      disabledSkipped: contrast.disabledSkipped, invisibleSkipped: contrast.invisibleSkipped,
      pairs: topOf(contrast.pairs, (a, b) => b.n - a.n),
      samples: topOf(contrast.bag, (a, b) => a.ratio - b.ratio || b.n - a.n),
      unknownSamples: topOf(contrast.unknownBag, (a, b) => b.n - a.n),
    },
    shape: {
      pills: shape.pills, pillsPainted: shape.pillsPainted, circles: shape.circles, roundedOver4: shape.roundedOver4,
      pillByKind: shape.pillByKind, radiusOver4: shape.radiusOver4, samples: topOf(shape.bag, (a, b) => b.n - a.n),
    },
  };
}

// ------------------------------------------------------------------ 실행

function slugOf(route) {
  const slug = route.replace(/^\/+/, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || 'home';
}

function kstNow() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date());
}

function scriptVersion() {
  try {
    const git = (args) => execFileSync('git', ['-C', __dirname, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const rev = git(['rev-parse', '--short=8', 'HEAD']);
    const dirty = git(['status', '--porcelain', '--', path.basename(__filename), path.basename(DEFAULT_ROUTES_FILE)]);
    return dirty ? `${rev}(+작업 중 수정)` : rev;
  } catch {
    return null;
  }
}

async function openPage(cdp, opts) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  let allowHosts = null;
  if (!opts.allowExternal) {
    const host = new URL(opts.base).hostname;
    allowHosts = new Set([host]);
    if (host === '127.0.0.1' || host === 'localhost') { allowHosts.add('127.0.0.1'); allowHosts.add('localhost'); }
  }
  const page = new PageSession(cdp, sessionId, allowHosts);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Network.enable');
  await page.send('Log.enable');
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: MUTATION_TRACKER });
  await page.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Seoul' }).catch(() => {});
  await page.send('Emulation.setLocaleOverride', { locale: 'ko-KR' }).catch(() => {});
  page.mediaFeatures = [];
  if (opts.forcedColors) page.mediaFeatures.push({ name: 'forced-colors', value: 'active' });
  if (opts.reducedMotion) page.mediaFeatures.push({ name: 'prefers-reduced-motion', value: 'reduce' });
  if (opts.colorScheme) page.mediaFeatures.push({ name: 'prefers-color-scheme', value: opts.colorScheme });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
  return page;
}

/**
 * 폭(과 높이)을 맞추고 미디어 흉내(강제 색·동작 줄이기·색 체계)를 그 뒤에 다시 겁니다. 경로마다 이동 전에 부릅니다 — 창 크기를 바꾸는
 * 캡처(아래) 뒤에도 다음 경로가 같은 조건에서 시작하게.
 */
async function setViewport(page, width, heightOverride = null) {
  const mobile = width < MOBILE_BELOW;
  const screenHeight = mobile ? MOBILE_HEIGHT : DESKTOP_HEIGHT;
  const height = heightOverride || screenHeight;
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight });
  await page.send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  await page.send('Emulation.setEmulatedMedia', { media: '', features: page.mediaFeatures });
}

/**
 * 전체 화면 캡처 — 창 높이를 화면 높이(contentHeight, 문서 + 본문 스크롤 상자가 넘친 만큼)로 늘리고 미디어 흉내를 다시 건 뒤 찍고 되돌립니다.
 * captureBeyondViewport를 쓰지 않는 이유: lg 이상 셸은 <main>이 스크롤 상자라 문서 밖으로 늘려도 첫 화면(900px)만 찍혔고,
 * Chrome 157에서는 그 캡처가 강제 색 흉내 없이 그려졌습니다(2026-11-16 확인). 창을 늘리면 고정 요소(아래 탭 바 등)가 화면 맨 아래에 그려집니다.
 */
async function captureFullPage(page, width, contentHeight, shotFile) {
  const height = Math.max(1, Math.min(Math.ceil(contentHeight), SHOT_MAX_HEIGHT));
  let shot;
  try {
    await setViewport(page, width, height);
    await sleep(400);
    shot = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } }, 90000);
  } finally {
    await setViewport(page, width);
  }
  fs.writeFileSync(shotFile, Buffer.from(shot.data, 'base64'));
  return { file: path.basename(shotFile), height, cut: Math.ceil(contentHeight) > SHOT_MAX_HEIGHT || undefined };
}

async function blank(page) {
  page.state.loadFired = false;
  await page.send('Page.navigate', { url: 'about:blank' });
  const until = Date.now() + 5000;
  while (!page.state.loadFired && Date.now() < until) await sleep(50);
}

async function auditRoute(page, opts, route, width, shotFile) {
  await blank(page);
  await setViewport(page, width);
  page.state = page.freshState();
  const started = Date.now();
  const nav = await page.send('Page.navigate', { url: opts.base + route }, 30000);
  if (nav.errorText) return { error: `이동 실패: ${nav.errorText}` };
  const settleInfo = await settle(page, opts.settleMax);
  const audit = await page.evaluate(`(${pageAudit.toString()})(${JSON.stringify({ viewportWidth: width, mobileBelow: MOBILE_BELOW, sampleMax: SAMPLE_MAX })})`, 60000);
  const st = page.state;
  const result = {
    route, width, mobile: width < MOBILE_BELOW, docStatus: st.docStatus, settle: settleInfo, elapsedMs: Date.now() - started,
    redirected: audit.path !== route ? audit.path : null,
    ...audit,
    console: {
      errors: st.consoleErrors.length + st.exceptions.length + st.logErrors.length,
      consoleErrors: st.consoleErrors.slice(0, SAMPLE_MAX), exceptions: st.exceptions.slice(0, SAMPLE_MAX), logErrors: st.logErrors.slice(0, SAMPLE_MAX),
    },
    network: {
      httpErrors: st.httpErrors.length, httpErrorSamples: st.httpErrors.slice(0, SAMPLE_MAX),
      failures: st.netFailures.length, failureSamples: st.netFailures.slice(0, SAMPLE_MAX),
      blockedWrites: st.blockedWrites, blockedExternal: Object.fromEntries(st.blockedExternal),
    },
    shot: null,
  };
  if (shotFile) {
    try {
      result.shot = await captureFullPage(page, width, audit.contentHeight, shotFile);
    } catch (error) {
      result.shot = { error: error.message };
    }
  }
  return result;
}

function countsOf(result) {
  if (result.error) return null;
  return {
    small: result.smallText.count,
    targets: result.targets.small,
    inline: result.targets.inline,
    overflowPage: result.overflow.page,
    overflowEls: result.overflow.count,
    contrastFail: result.contrast.fail,
    contrastUnknown: result.contrast.unknown,
    pills: result.shape.pills,
    console: result.console.errors,
    httpErrors: result.network.httpErrors,
    blockedWrites: result.network.blockedWrites.length,
    height: result.contentHeight,
  };
}

function noteOf(row) {
  const notes = [];
  if (row.error) notes.push(`오류: ${row.error}`);
  if (row.settle === 'timeout') notes.push('대기 초과');
  if (row.redirected) notes.push(`이동됨 → ${row.redirected}`);
  if (row.docStatus && row.docStatus !== 200) notes.push(`HTTP ${row.docStatus}`);
  if (row.counts && row.counts.blockedWrites) notes.push(`막은 쓰기 ${row.counts.blockedWrites}`);
  if (row.counts && row.counts.httpErrors) notes.push(`4xx·5xx ${row.counts.httpErrors}`);
  return notes.join(', ');
}

function renderSummary(meta, rows) {
  const lines = [];
  lines.push('# 화면 감사 요약 (ui-audit.js)', '');
  lines.push(`- 기준 주소: ${meta.base} · 시각(KST): ${meta.startedKst} ~ ${meta.finishedKst || '진행 중'}`);
  lines.push(`- 폭: ${meta.widths.join(', ')} · 강제 색: ${meta.forcedColors ? '켬' : '끔'} · 동작 줄이기: ${meta.reducedMotion ? '켬' : '끔'} · 색 체계 흉내: ${meta.colorScheme || '없음(브라우저 기본)'}`);
  lines.push(`- 스크립트: ${meta.scriptVersion || '알 수 없음'} · 브라우저: ${meta.browser} · 경로 ${meta.routeCount}개(${meta.routesFile || '기본 목록'})`);
  lines.push('- 칸: 12px 미만 글 요소 · 작은 누름 자리(문장 속 링크 뺌) · 문장 속 링크 · 문서 가로 넘침(px) · 넘친 요소 · 대비 미달 · 대비 모름 · 알약 모양 · 콘솔 오류 · 화면 높이(px, 합계 없음)');
  lines.push('- 이 요약에는 화면 글을 넣지 않습니다. 표본은 경로별 JSON에 있습니다(커밋 금지).', '');
  const header = '| 경로 | 12px 미만 | 작은 누름 | 문장 속 링크 | 문서 넘침 | 넘친 요소 | 대비 미달 | 대비 모름 | 알약 | 콘솔 오류 | 높이 | 비고 |';
  const rule = '|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|';
  const keys = ['small', 'targets', 'inline', 'overflowPage', 'overflowEls', 'contrastFail', 'contrastUnknown', 'pills', 'console'];
  const grand = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const width of meta.widths) {
    const part = rows.filter((row) => row.width === width);
    if (!part.length) continue;
    lines.push(`## 폭 ${width}px (누름 자리 기준 ${width < MOBILE_BELOW ? 44 : 24}px)`, '', header, rule);
    const total = Object.fromEntries(keys.map((key) => [key, 0]));
    let overflowRoutes = 0;
    for (const row of part) {
      const c = row.counts;
      if (c) {
        for (const key of keys) total[key] += key === 'overflowPage' ? 0 : c[key];
        if (c.overflowPage > 0) overflowRoutes += 1;
      }
      const cells = c ? [...keys.map((key) => String(c[key])), String(c.height)] : [...keys.map(() => '-'), '-'];
      lines.push(`| \`${row.route}\` | ${cells.join(' | ')} | ${noteOf(row)} |`);
    }
    total.overflowPage = overflowRoutes;
    for (const key of keys) grand[key] += total[key];
    lines.push(`| **합계(${part.length}개)** | ${keys.map((key) => (key === 'overflowPage' ? `${total[key]}곳` : String(total[key]))).join(' | ')} | | |`, '');
  }
  lines.push('## 전체 합계', '', '| 폭 묶음 | 12px 미만 | 작은 누름 | 문장 속 링크 | 문서 넘침(곳) | 넘친 요소 | 대비 미달 | 대비 모름 | 알약 | 콘솔 오류 |',
    '|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|', `| 모든 폭 | ${keys.map((key) => String(grand[key])).join(' | ')} |`, '');
  const blocked = rows.filter((row) => row.counts && row.counts.blockedWrites);
  if (blocked.length) lines.push(`참고: 쓰기 요청을 막은 화면 ${blocked.length}곳(JSON의 network.blockedWrites).`, '');
  return `${lines.join('\n')}\n`;
}

async function main() {
  let opts;
  let routeInfo;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.help) { process.stdout.write(`${USAGE}\n`); return 0; }
    routeInfo = loadRoutes(opts.routes);
    if (opts.only) routeInfo.routes = routeInfo.routes.filter((route) => route.includes(opts.only));
    if (opts.list) { process.stdout.write(`${routeInfo.routes.join('\n')}\n`); return 0; }
    if (!opts.base) throw new UsageError('--base가 필요합니다');
    if (!routeInfo.routes.length) throw new UsageError('고른 경로가 없습니다(--only 확인)');
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`오류: ${error.message}\n${USAGE}\n`);
      return 2;
    }
    throw error;
  }
  if (typeof WebSocket !== 'function') {
    process.stderr.write('오류: 전역 WebSocket이 없습니다 — Node 22 이상이 필요합니다\n');
    return 1;
  }
  const outDir = path.resolve(opts.out || fs.mkdtempSync(path.join(os.tmpdir(), 'ui-audit-')));
  fs.mkdirSync(outDir, { recursive: true });
  const shotDir = opts.shots ? path.resolve(opts.shots) : null;
  if (shotDir) fs.mkdirSync(shotDir, { recursive: true });

  const chrome = await launchChrome(opts.chrome);
  let cdp = null;
  const stop = () => { if (cdp) cdp.close(); chrome.close().finally(() => process.exit(130)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const rows = [];
  const meta = {
    base: opts.base, widths: opts.widths, forcedColors: opts.forcedColors, reducedMotion: opts.reducedMotion, colorScheme: opts.colorScheme,
    routesFile: routeInfo.file ? path.relative(process.cwd(), routeInfo.file) : null, routeCount: routeInfo.routes.length,
    scriptVersion: scriptVersion(), startedKst: kstNow(), finishedKst: null, browser: null, chrome: chrome.executable,
    settleRule: SETTLE, sampleMax: SAMPLE_MAX,
  };
  try {
    cdp = await Cdp.connect(chrome.wsUrl);
    meta.browser = (await cdp.send('Browser.getVersion')).product;
    const page = await openPage(cdp, opts);
    const total = opts.widths.length * routeInfo.routes.length;
    const usedNames = new Set();
    let done = 0;
    for (const width of opts.widths) {
      for (const route of routeInfo.routes) {
        done += 1;
        let base = `${slugOf(route)}__w${width}`;
        for (let n = 2; usedNames.has(base); n += 1) base = `${slugOf(route)}_${n}__w${width}`;
        usedNames.add(base);
        let result;
        try {
          result = await auditRoute(page, opts, route, width, shotDir ? path.join(shotDir, `${base}.png`) : null);
        } catch (error) {
          if (cdp.closed) throw error;
          result = { error: error.message };
        }
        result = { route, width, ...result };
        fs.writeFileSync(path.join(outDir, `${base}.json`), `${JSON.stringify(result, null, 2)}\n`);
        const row = {
          route, width, file: `${base}.json`, error: result.error || null, settle: result.settle ? result.settle.reason : null,
          redirected: result.redirected || null, docStatus: result.docStatus || null, counts: countsOf(result),
        };
        rows.push(row);
        const c = row.counts;
        const brief = c
          ? `12px미만 ${c.small} 누름 ${c.targets}(+문장 ${c.inline}) 넘침 ${c.overflowPage}px/${c.overflowEls} 대비 ${c.contrastFail}(모름 ${c.contrastUnknown}) 알약 ${c.pills} 오류 ${c.console}`
          : `오류: ${row.error}`;
        process.stderr.write(`[${done}/${total}] ${width} ${route} ${result.settle ? `${result.settle.reason} ${result.settle.ms}ms` : ''} ${brief}${noteOf(row) && c ? ` (${noteOf(row)})` : ''}\n`);
        fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify({ meta, rows }, null, 2)}\n`);
      }
    }
    meta.finishedKst = kstNow();
    fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify({ meta, rows }, null, 2)}\n`);
    fs.writeFileSync(path.join(outDir, 'summary.md'), renderSummary(meta, rows));
  } finally {
    if (cdp) cdp.close();
    await chrome.close();
  }
  process.stderr.write(`끝: ${outDir}/summary.md${shotDir ? ` · 캡처 ${shotDir}(커밋 금지)` : ''}\n`);
  return rows.length && rows.every((row) => row.error) ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (error) => {
  process.stderr.write(`오류: ${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
