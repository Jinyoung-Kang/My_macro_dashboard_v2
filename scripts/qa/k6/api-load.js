// scripts/qa/k6/api-load.js — 핵심 API 부하 시험 (QA 스택). 로그인 뒤 세션 쿠키로 호출.
// 사용: k6 run -e BASE=http://127.0.0.1:18082 -e EMAIL="$(grep ^OWNER_EMAIL= .env.qa | cut -d= -f2-)" -e PASSWORD="$(grep ^APP_PASSWORD= .env.qa | cut -d= -f2-)" \
//        -e ORIGIN=http://localhost:13002 -e VUS=10 -e DURATION=60s scripts/qa/k6/api-load.js
// 결과: p95·처리량·오류율. 임계값(thresholds)을 넘으면 종료 코드가 0이 아닙니다.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://127.0.0.1:18082';
const ORIGIN = __ENV.ORIGIN || 'http://localhost:13002';
const ENDPOINTS = [
  '/api/macro/overview', '/api/macro/risk', '/api/liquidity?years=3', '/api/sector/momentum',
  '/api/sec13f/portfolio?cik=0001608046&quarters=8&topN=30', '/api/sec13f/consensus?minHolders=2',
  '/api/guru/profiles', '/api/guru/similarity', '/api/stock/scorecard?symbol=AAPL&benchmark=SPY&years=1',
  '/api/cot/extremes?name=S%26P%20500%20E-Mini&percentile=95&lookbackWeeks=52', '/api/krx/futures?days=60', '/api/radar/ranking',
  '/api/kr/investor-flows', '/api/analytics/regime?years=5', '/api/status', '/api/snapshot/text',
];
const perEndpoint = {};
for (const e of ENDPOINTS) perEndpoint[e] = new Trend('t_' + e.replace(/[^a-z0-9]/gi, '_').slice(0, 60), true);

export const options = {
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || '60s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1500'],
  },
};

export function setup() {
  const res = http.post(`${BASE}/api/auth/login`, JSON.stringify({ email: __ENV.EMAIL || '', password: __ENV.PASSWORD || '' }),
    { headers: { 'Content-Type': 'application/json', Origin: ORIGIN } });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  const cookie = res.cookies.my_macro_v2_session && res.cookies.my_macro_v2_session[0] ? res.cookies.my_macro_v2_session[0].value : null;
  if (!cookie) throw new Error('no session cookie');
  return { cookie };
}

export default function (data) {
  const e = ENDPOINTS[Math.floor(Math.random() * ENDPOINTS.length)];
  const res = http.get(`${BASE}${e}`, { cookies: { my_macro_v2_session: data.cookie }, tags: { endpoint: e } });
  perEndpoint[e].add(res.timings.duration);
  check(res, { 'status 200': (r) => r.status === 200 });
  sleep(0.1);
}
