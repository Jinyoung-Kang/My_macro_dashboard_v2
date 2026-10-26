// scripts/qa/k6/concurrent.js — 같은 요청이 동시에 들어올 때 (QA 스택).
//   SCENARIO=refresh : POST /api/status/refresh 20개 동시 → refresh_requests 행이 1건만 늘고 수집은 한 번
//   SCENARIO=run     : POST /api/status/run/kr_holidays 20개 동시 → collector_task_runs 1회 실행 + 나머지 합류
//   SCENARIO=login   : 틀린 비밀번호 30개 동시 → 429/401만, 500 없음, 맞는 비밀번호는 통과
// 사용: k6 run -e SCENARIO=refresh -e PASSWORD=… scripts/qa/k6/concurrent.js
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE || 'http://127.0.0.1:18082';
const ORIGIN = __ENV.ORIGIN || 'http://localhost:13002';
const SCENARIO = __ENV.SCENARIO || 'refresh';
export const options = { scenarios: { burst: { executor: 'per-vu-iterations', vus: SCENARIO === 'login' ? 30 : 20, iterations: 1 } } };

export function setup() {
  if (SCENARIO === 'login') return {};
  const res = http.post(`${BASE}/api/auth/login`, JSON.stringify({ email: __ENV.EMAIL || '', password: __ENV.PASSWORD || '' }),
    { headers: { 'Content-Type': 'application/json', Origin: ORIGIN } });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return { cookie: res.cookies.my_macro_v2_session[0].value };
}

export default function (data) {
  let res;
  if (SCENARIO === 'refresh') {
    res = http.post(`${BASE}/api/status/refresh?runFast=true`, null, { cookies: { my_macro_v2_session: data.cookie }, timeout: '120s' });
  } else if (SCENARIO === 'run') {
    res = http.post(`${BASE}/api/status/run/kr_holidays`, null, { cookies: { my_macro_v2_session: data.cookie }, timeout: '120s' });
  } else {
    res = http.post(`${BASE}/api/auth/login`, JSON.stringify({ email: __ENV.EMAIL || '', password: 'wrong-' + __VU }),
      { headers: { 'Content-Type': 'application/json', Origin: ORIGIN } });
  }
  check(res, { 'no 5xx': (r) => r.status < 500, 'status': (r) => { console.log(`VU${__VU} ${r.status} ${r.timings.duration.toFixed(0)}ms ${r.body ? String(r.body).slice(0, 100) : ''}`); return true; } });
}
