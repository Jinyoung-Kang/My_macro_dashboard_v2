// scripts/qa/k6/uncached-load.js — 응답 캐시(ComputedCache) 밖의 경로를 동시에 몰아 부를 때 서버가 버티는지 잽니다(QA-133, QA 스택).
//
// 세 시나리오가 함께 돕니다.
//   load   : VUS명이 ROUTE 하나를 쉬지 않고 부름(요청 시간 초과 30초). load_ms(지연) · load_200·load_429·load_other(건수).
//   health : 1초에 한 번 GET /api/health(인증 없음, 시간 초과 5초 — 컨테이너 헬스체크와 같은 값). health_ms · health_ok.
//   session: 1초에 한 번 GET /api/auth/session(로그인 쿠키 — 필터가 DB에서 세션을 읽음). DB 연결 풀이 막히면 여기가 먼저
//            느려집니다. session_ms · session_ok.
//
// ROUTE(기본 holders-wide):
//   correlation-ui  화면에서 고를 수 있는 가장 큰 조합(window 250 · years 10, FRED 10년물·2년물)
//   correlation-max 화면 밖 최악(window 1280 · years 100) — QA-133 뒤로는 서버가 250 · 10년으로 접어 correlation-ui와 같은
//                   계산입니다(수정 전·후 비교용)
//   radar-all       레이더 이력 전 기간(파라미터 없음 — 화면은 늘 latest=true). QA-133 뒤로는 최신 5,000행까지
//   holders-wide    보유 검색 q=C(한 글자, 13F 최신 분기 대부분이 걸림). QA-133 뒤로는 비중 상위 200행까지
//   holders-narrow  보유 검색 q=NVIDIA
//   ai-report       POST /api/ai/report — QA 스택은 AI 키가 없어, 수정 전에는 원본 텍스트를 다 만든 뒤 과금 없이 실패(한도를
//                   되돌려받음). QA-133 뒤로는 한도·원본 텍스트 전에 바로 끝나 그 경로를 재지 않습니다(수정 전·후 비교용)
//
// 사용(QA 스택에서만 — 운영 스택 8080에 돌리지 않습니다):
//   k6 run -e BASE=http://127.0.0.1:18082 -e ORIGIN=http://localhost:13002 \
//     -e EMAIL="$(grep ^OWNER_EMAIL= .env.qa | cut -d= -f2-)" -e PASSWORD="$(grep ^APP_PASSWORD= .env.qa | cut -d= -f2-)" \
//     -e ROUTE=holders-wide -e VUS=20 -e DURATION=60s scripts/qa/k6/uncached-load.js
//   429는 서버가 덜어 낸 요청(shed)이라 load에서는 실패로 보지 않고 따로 셉니다. health·session은 200만 성공입니다.
import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";

const BASE = __ENV.BASE || "http://127.0.0.1:18082";
const ORIGIN = __ENV.ORIGIN || "http://localhost:13002";
const ROUTE = __ENV.ROUTE || "holders-wide";
const VUS = Number(__ENV.VUS || 20);
const DURATION = __ENV.DURATION || "60s";

const ROUTES = {
  "correlation-ui": { method: "GET", path: "/api/analytics/correlation?x=fred:DGS10&y=fred:DGS2&window=250&years=10&mode=change" },
  "correlation-max": { method: "GET", path: "/api/analytics/correlation?x=fred:DGS10&y=fred:DGS2&window=1280&years=100&mode=change" },
  "radar-all": { method: "GET", path: "/api/radar/history" },
  "holders-wide": { method: "GET", path: "/api/guru/holders?q=C" },
  "holders-narrow": { method: "GET", path: "/api/guru/holders?q=NVIDIA" },
  "ai-report": { method: "POST", path: "/api/ai/report", body: JSON.stringify({ engineId: "auto", extraInstruction: "" }) },
};
const target = ROUTES[ROUTE];
if (!target) throw new Error(`ROUTE는 ${Object.keys(ROUTES).join(" · ")} 중 하나`);

const loadMs = new Trend("load_ms", true);
const load200 = new Counter("load_200");
const load429 = new Counter("load_429");
const loadOther = new Counter("load_other");
const healthMs = new Trend("health_ms", true);
const healthOk = new Rate("health_ok");
const sessionMs = new Trend("session_ms", true);
const sessionOk = new Rate("session_ok");

export const options = {
  discardResponseBodies: true,
  scenarios: {
    load: { executor: "constant-vus", vus: VUS, duration: DURATION, exec: "load", gracefulStop: "35s" },
    health: { executor: "constant-arrival-rate", rate: 1, timeUnit: "1s", duration: DURATION, preAllocatedVUs: 10,
      exec: "health", gracefulStop: "10s" },
    session: { executor: "constant-arrival-rate", rate: 1, timeUnit: "1s", duration: DURATION, preAllocatedVUs: 10,
      exec: "session", gracefulStop: "10s" },
  },
};

export function setup() {
  const res = http.post(`${BASE}/api/auth/login`, JSON.stringify({ email: __ENV.EMAIL, password: __ENV.PASSWORD }),
    { headers: { "Content-Type": "application/json", Origin: ORIGIN } });
  const cookie = res.cookies.my_macro_v2_session && res.cookies.my_macro_v2_session[0];
  if (res.status !== 200 || !cookie) throw new Error(`로그인 실패: ${res.status}`);
  return { session: cookie.value };
}

function authed(data) {
  return { headers: { Origin: ORIGIN, "Content-Type": "application/json", "Accept-Encoding": "gzip" },
    cookies: { my_macro_v2_session: data.session }, timeout: "30s" };
}

export function load(data) {
  const res = target.method === "POST"
    ? http.post(`${BASE}${target.path}`, target.body, authed(data))
    : http.get(`${BASE}${target.path}`, authed(data));
  loadMs.add(res.timings.duration);
  if (res.status === 200) load200.add(1);
  else if (res.status === 429) load429.add(1);
  else loadOther.add(1, { status: String(res.status) });
}

export function health() {
  const res = http.get(`${BASE}/api/health`, { timeout: "5s" });
  healthMs.add(res.timings.duration);
  healthOk.add(res.status === 200);
}

export function session(data) {
  const res = http.get(`${BASE}/api/auth/session`, { ...authed(data), timeout: "5s" });
  sessionMs.add(res.timings.duration);
  sessionOk.add(res.status === 200);
}

function pick(name, stat) {
  const metric = globalThis.__data.metrics[name];
  return metric && metric.values[stat] !== undefined ? metric.values[stat] : null;
}

function fmt(value, digits = 0) {
  return value === null ? "—" : Number(value).toFixed(digits);
}

export function handleSummary(data) {
  globalThis.__data = data;
  const lines = [
    `ROUTE=${ROUTE} VUS=${VUS} DURATION=${DURATION}`,
    `load    : 200 ${fmt(pick("load_200", "count"))} · 429 ${fmt(pick("load_429", "count"))} · 그 밖 ${fmt(pick("load_other", "count"))}`
      + ` · 중앙 ${fmt(pick("load_ms", "med"))}ms · p95 ${fmt(pick("load_ms", "p(95)"))}ms · 최대 ${fmt(pick("load_ms", "max"))}ms`,
    `health  : 200 비율 ${fmt(100 * (pick("health_ok", "rate") ?? 0), 1)}% · 중앙 ${fmt(pick("health_ms", "med"))}ms`
      + ` · p95 ${fmt(pick("health_ms", "p(95)"))}ms · 최대 ${fmt(pick("health_ms", "max"))}ms`,
    `session : 200 비율 ${fmt(100 * (pick("session_ok", "rate") ?? 0), 1)}% · 중앙 ${fmt(pick("session_ms", "med"))}ms`
      + ` · p95 ${fmt(pick("session_ms", "p(95)"))}ms · 최대 ${fmt(pick("session_ms", "max"))}ms`,
  ];
  return { stdout: lines.join("\n") + "\n" };
}
