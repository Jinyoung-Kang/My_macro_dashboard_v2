// scripts/qa/k6/core-get.js — 화면이 자주 부르는 11경로 혼합 부하 (QA 스택). 2026-11-04 측정(docs/qa/2026-11-04-qa-results.md 3-1)과
// 2026-11-22 기준선(docs/qa/evidence/2026-11-22-perf/baseline.txt 2절)이 쓴 조건 그대로 — 닫힌 고리(가상 사용자가 응답을 받자마자 다음 요청),
// 생각 시간 0, 경로는 아래 11개 가운데 무작위.
// 사용(이 PC에는 k6가 없어 docker 이미지로):
//   docker run --rm --network host -v "$PWD/scripts/qa/k6:/s:ro" grafana/k6:2.3.0 run -q -e VUS=50 -e DURATION=60s /s/core-get.js
//   단계 넷(1·5·20·50명)과 컨테이너 자원을 한 번에: bash scripts/qa/k6/core-get.sh [출력파일]
// 로그인: 백엔드가 로그인 없는 모드(GET /api/auth/session의 noLogin)면 쿠키 없이, 아니면 EMAIL·PASSWORD(-e)로 로그인해 쿠키로.
// 출력(표준출력): 전체 p50·p95·p99·최대·처리량·실패율·429 수·그 밖 오류 수, 경로별 p50·p95·p99.
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://127.0.0.1:18082';
const ORIGIN = __ENV.ORIGIN || 'http://localhost:13002';
const ROUTES = {
  home_regime: '/api/analytics/regime?years=5',
  home_issues: '/api/status/issues',
  home_unread: '/api/alerts/unread-count',
  macro_overview: '/api/macro/overview',
  paper_overview_us: '/api/paper/overview?market=US',
  paper_overview_kr: '/api/paper/overview?market=KR',
  paper_status_us: '/api/paper/status?market=US',
  paper_status_kr: '/api/paper/status?market=KR',
  sec13f_institutions: '/api/sec13f/institutions',
  detail_quote_us: '/api/detail/quote?market=us&code=AAPL',
  live_prices: '/api/live/prices?items=US:AAPL',
};
const NAMES = Object.keys(ROUTES);
const trends = {};
for (const n of NAMES) trends[n] = new Trend(`r_${n}`, true);
const tooMany = new Counter('status_429');
const otherErrors = new Counter('status_other');

export const options = {
  vus: Number(__ENV.VUS || 1),
  duration: __ENV.DURATION || '60s',
  summaryTrendStats: ['med', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const session = http.get(`${BASE}/api/auth/session`);
  if (session.status === 200 && session.json('noLogin') === true) return { cookie: null };
  const res = http.post(`${BASE}/api/auth/login`, JSON.stringify({ email: __ENV.EMAIL || '', password: __ENV.PASSWORD || '' }),
    { headers: { 'Content-Type': 'application/json', Origin: ORIGIN } });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  const c = res.cookies.my_macro_v2_session && res.cookies.my_macro_v2_session[0];
  if (!c) throw new Error('no session cookie');
  return { cookie: c.value };
}

export default function (data) {
  const name = NAMES[Math.floor(Math.random() * NAMES.length)];
  const params = { tags: { route: name } };
  if (data.cookie) params.cookies = { my_macro_v2_session: data.cookie };
  const res = http.get(`${BASE}${ROUTES[name]}`, params);
  trends[name].add(res.timings.duration);
  if (res.status === 429) tooMany.add(1);
  else if (res.status !== 200) otherErrors.add(1);
}

function v(metric, stat) {
  const m = metric && metric.values;
  return m && m[stat] !== undefined ? m[stat] : null;
}

function f(x) {
  return x === null ? '-' : x.toFixed(1);
}

export function handleSummary(data) {
  const m = data.metrics;
  const d = m.http_req_duration;
  const lines = [];
  lines.push(`vu${options.vus}: 전체 p50 ${f(v(d, 'med'))} p95 ${f(v(d, 'p(95)'))} p99 ${f(v(d, 'p(99)'))} max ${f(v(d, 'max'))}ms · `
    + `${f(v(m.http_reqs, 'rate'))} req/s · 실패율 ${(100 * (v(m.http_req_failed, 'rate') || 0)).toFixed(2)}% · `
    + `429 ${v(m.status_429, 'count') || 0} · 그밖 오류 ${v(m.status_other, 'count') || 0}`);
  for (const n of NAMES) {
    const t = m[`r_${n}`];
    lines.push(`   ${n.padEnd(20)} p50 ${f(v(t, 'med'))} p95 ${f(v(t, 'p(95)'))} p99 ${f(v(t, 'p(99)'))}`);
  }
  return { stdout: lines.join('\n') + '\n' };
}
