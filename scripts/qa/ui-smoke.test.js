// scripts/qa/ui-smoke.test.js — 브라우저 연기 시험 스크립트의 순수 함수 시험(의존성 없음 — Node 내장 node:test).
//   node --test scripts/qa/ui-smoke.test.js
// 브라우저를 띄우지 않습니다 — 인자 해석, 대상·쓰기 가드, 화면 판정, '쓰기 뒤 다시 읽기' 순서 판정, 요약과 끝 코드.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const smoke = require('./ui-smoke.js');

/** 아무 문제 없는 화면 한 장의 관찰값 — 시험마다 한 칸씩 어긋나게 바꿉니다. */
const clean = (over = {}) => ({
  docStatus: 200, path: '/macro', settle: 'idle', consoleErrors: [], httpErrors: [], netFailures: [],
  h1: ['매크로'], mainH1: true, mainText: 400, errorScreen: false, notFoundScreen: false, ...over,
});
const checks = (route, obs, rule) => smoke.judgeRoute(route, obs, rule).map((v) => v.check);

test('인자 — 기본값과 주소 다듬기', () => {
  const opts = smoke.parseArgs(['--base', 'http://127.0.0.1:13002/', '--only', '/paper', '--strict-flows']);
  assert.equal(opts.base, 'http://127.0.0.1:13002');
  assert.equal(opts.only, '/paper');
  assert.equal(opts.width, 1440);
  assert.equal(opts.flows, 'on');
  assert.equal(opts.strictFlows, true);
  assert.deepEqual(smoke.parseArgs(['--block', '*/api/regime*, */api/x*']).block, ['*/api/regime*', '*/api/x*']);
});

test('인자 — 모르는 인자·값 없는 인자·함께 못 쓰는 인자는 오류', () => {
  assert.throws(() => smoke.parseArgs(['--nope']), /모르는 인자/);
  assert.throws(() => smoke.parseArgs(['--base']), /값이 필요/);
  assert.throws(() => smoke.parseArgs(['--base', 'ftp://x']), /http/);
  assert.throws(() => smoke.parseArgs(['--width', '10']), /--width/);
  assert.throws(() => smoke.parseArgs(['--no-flows', '--flows-only']), /함께 쓰지/);
});

test('.env 읽기 — 쓰는 세 값만, 따옴표를 벗기고 빈 값은 null', () => {
  const env = smoke.parseEnvText('# 주석\nOWNER_EMAIL=qa-owner@qa.local\nAPP_PASSWORD="abc=def"\nFRONTEND_PORT=13002\nOTHER_LINE=zzz\nFRONTEND_PORT=9\n');
  assert.deepEqual(env, { frontendPort: '13002', ownerEmail: 'qa-owner@qa.local', appPassword: 'abc=def' });
  assert.deepEqual(smoke.parseEnvText('APP_PASSWORD=\n'), { frontendPort: null, ownerEmail: null, appPassword: null });
});

test('대상 — --base가 없으면 .env.qa의 화면 포트', () => {
  assert.deepEqual(smoke.resolveTarget(null, { frontendPort: '13002' }), { ok: true, base: 'http://127.0.0.1:13002', portMatches: true });
  assert.equal(smoke.resolveTarget(null, null).ok, false);
});

test('대상 — 이 PC가 아니거나 .env.qa의 화면 포트가 아니면 거절(로컬 스택 3002·운영)', () => {
  assert.equal(smoke.resolveTarget('http://127.0.0.1:3002', { frontendPort: '13002' }).ok, false);
  assert.equal(smoke.resolveTarget('https://example.invalid', { frontendPort: '13002' }).ok, false);
  assert.equal(smoke.resolveTarget('http://localhost:13002', { frontendPort: '13002' }).portMatches, true);
  // .env.qa가 없으면 이 PC 주소는 읽기만 열고(portMatches 거짓) 쓰기 가드가 흐름을 막습니다.
  assert.deepEqual(smoke.resolveTarget('http://127.0.0.1:13002', null), { ok: true, base: 'http://127.0.0.1:13002', portMatches: false });
});

test('쓰기 가드 — 포트 대조와 qa@ 빌드 정보가 모두 있어야 열림', () => {
  assert.equal(smoke.writeGuard({ portMatches: true, build: 'qa@1a2b3c4' }).ok, true);
  assert.equal(smoke.writeGuard({ portMatches: false, build: 'qa@1a2b3c4' }).ok, false);
  assert.equal(smoke.writeGuard({ portMatches: true, build: 'main@1a2b3c4' }).ok, false);
  assert.equal(smoke.writeGuard({ portMatches: true, build: null }).ok, false);
});

test('쓰기 허용 목록 — 방식과 경로가 정확히 같을 때만', () => {
  const allowed = new Set(['DELETE /api/sec13f/favorites/0009910001']);
  assert.equal(smoke.writeAllowed(allowed, 'delete', '/api/sec13f/favorites/0009910001'), true);
  assert.equal(smoke.writeAllowed(allowed, 'DELETE', '/api/sec13f/favorites/0009910002'), false);
  assert.equal(smoke.writeAllowed(allowed, 'POST', '/api/sec13f/favorites/0009910001'), false);
  assert.equal(smoke.writeAllowed(new Set(), 'POST', '/api/realtrade/enable'), false);
});

test('판정 — 문제없는 화면은 위반 0, 질의가 붙은 경로는 경로만 견줌', () => {
  assert.deepEqual(smoke.judgeRoute('/macro', clean()), []);
  assert.deepEqual(smoke.judgeRoute('/search?q=NVDA', clean({ path: '/search' })), []);
  assert.equal(smoke.routePath('/search?e=us:NVDA&tab=timeline'), '/search');
});

test('판정 — 확인마다 한 줄씩 어긋남을 잡음', () => {
  assert.deepEqual(checks('/macro', clean({ docStatus: 500 })), ['문서 200']);
  assert.deepEqual(checks('/macro', clean({ path: '/login' })), ['로그인 화면으로 밀려나지 않음']);
  assert.deepEqual(checks('/macro', clean({ path: '/' })), ['주소 그대로']);
  assert.deepEqual(checks('/macro', clean({ consoleErrors: ['TypeError: x is undefined'] })), ['콘솔 오류·예외 0']);
  assert.deepEqual(checks('/macro', clean({ httpErrors: [{ status: 500, path: '/api/macro' }] })), ['예상 밖 HTTP 400 이상 0']);
  assert.deepEqual(checks('/macro', clean({ netFailures: [{ type: 'Fetch', error: 'net::ERR_FAILED' }] })), ['네트워크 실패 0']);
  assert.deepEqual(checks('/macro', clean({ errorScreen: true })), ['오류 경계 문구 없음']);
  assert.deepEqual(checks('/macro', clean({ notFoundScreen: true })), ["'찾을 수 없는 화면' 문구 없음"]);
  assert.deepEqual(checks('/macro', clean({ mainH1: false })), ['main h1 있음']);
  assert.deepEqual(checks('/macro', clean({ mainText: 3 })), ['본문이 비지 않음']);
  assert.deepEqual(checks('/macro', clean({ settle: 'timeout' })), ['기다림 안에 조용해짐']);
  assert.deepEqual(checks('/macro', { error: '이동 실패: net::ERR_CONNECTION_REFUSED' }), ['화면 열기']);
});

test('판정 — 경로별 예외(허용 응답·허용 콘솔 글·가도 되는 주소)만 넘어감', () => {
  const rule = { allowHttp: [{ status: 404, path: /^\/api\/x$/ }], allowConsole: [/hydration/], redirect: '/home' };
  assert.deepEqual(smoke.judgeRoute('/macro', clean({ path: '/home', httpErrors: [{ status: 404, path: '/api/x' }], consoleErrors: ['hydration note'] }), rule), []);
  assert.deepEqual(checks('/macro', clean({ httpErrors: [{ status: 500, path: '/api/x' }, { status: 404, path: '/api/y' }] }), rule), ['예상 밖 HTTP 400 이상 0']);
});

test('경로별 예외 표의 열쇠는 모두 경로 목록에 있다(지운 경로의 예외가 남지 않게)', () => {
  const routes = fs.readFileSync(path.join(__dirname, 'ui-audit-routes.txt'), 'utf8').split('\n').map((line) => line.replace(/#.*$/, '').trim()).filter(Boolean);
  for (const key of Object.keys(smoke.ROUTE_RULES)) assert.ok(routes.includes(key), `ROUTE_RULES의 ${key}가 경로 목록에 없음`);
});

test('쓰기 뒤 다시 읽기(QA-1008) — 쓰기가 끝난 뒤에 나간 GET이 있어야 통과', () => {
  const write = { method: 'PATCH', path: '/api/sec13f/favorites/0009910002' };
  const read = '/api/sec13f/institutions';
  const patch = { method: 'PATCH', path: write.path, t0: 10, t1: 11, status: 200 };
  // 쓰기 전에 나가 있던 GET에 합류한 꼴(옛 결함) — 쓰기 뒤에 끝났어도 나간 때가 쓰기 전이면 실패.
  assert.equal(smoke.rereadAfterWrite([{ method: 'GET', path: read, t0: 9.5, t1: 11.5, status: 200 }, patch], write, read).ok, false);
  assert.equal(smoke.rereadAfterWrite([patch, { method: 'GET', path: read, t0: 11.2, t1: 11.4, status: 200 }], write, read).ok, true);
  assert.equal(smoke.rereadAfterWrite([patch, { method: 'GET', path: read, t0: 11.2, t1: 11.4, status: 500 }], write, read).ok, false);
  assert.equal(smoke.rereadAfterWrite([{ method: 'GET', path: read, t0: 12, t1: 13, status: 200 }], write, read).ok, false);
  assert.equal(smoke.rereadAfterWrite([{ ...patch, t1: null }], write, read).ok, false);
});

test('씨앗 이름에서 CIK — 씨앗 머리가 아니면 null(다른 즐겨찾기는 건드리지 않음)', () => {
  assert.equal(smoke.seedCik('[QA 연기] 가짜 제출자 9910001'), '0009910001');
  assert.equal(smoke.seedCik('[QA 연기] 고친 이름 9910002'), '0009910002');
  assert.equal(smoke.seedCik('[QA] 가짜 제출자 3'), null);
  assert.equal(smoke.seedCik('Berkshire Hathaway'), null);
  assert.equal(smoke.seedCik('[QA 연기] 숫자 없음'), null);
});

test('요약 — 실패가 하나라도 있으면 끝 코드 1, 건너뜀은 --strict-flows일 때만 실패', () => {
  const rows = [{ violations: [], retried: true }, { violations: [], retried: false }];
  const flows = [{ state: 'pass' }, { state: 'skip' }, { state: 'na' }];
  assert.equal(smoke.summarize(rows, flows, false).exitCode, 0);
  assert.equal(smoke.summarize(rows, flows, true).exitCode, 1);
  assert.equal(smoke.summarize(rows, [{ state: 'fail' }], false).exitCode, 1);
  assert.equal(smoke.summarize([{ violations: [{ check: 'x', detail: 'y' }], retried: false }], [], false).exitCode, 1);
  assert.deepEqual(smoke.summarize(rows, flows, false), {
    routes: 2, passedRoutes: 2, failedRoutes: 0, retried: 1, flows: 3, passedFlows: 1, failedFlows: 0, skippedFlows: 1, naFlows: 1, exitCode: 0,
  });
});
