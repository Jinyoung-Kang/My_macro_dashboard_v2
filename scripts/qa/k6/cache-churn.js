// scripts/qa/k6/cache-churn.js — 응답 캐시(ComputedCache: 256개 LRU · 60초)가 서로 다른 키에 밀려나는지, 그리고 비싼 계산이
// 몰릴 때 서버가 버티는지(QA-131) 잽니다 (QA 스택).
//
// 다섯 시나리오가 함께 돕니다.
//   hot   : HOT_VUS명(기본 10)이 비싼 키 5개를 돌아가며 1초 간격으로 읽음 — 화면을 보고 있는 사람들(키마다 1초에 한 번,
//           같은 순간에 HOT_VUS/5명)
//   rare  : 1명이 위험 분석 한 조합을 RARE_EVERY초(기본 20)마다 읽음 — 가장 먼저 밀려날 키(가장 민감한 탐침)
//   churn : 초당 RATE번, 화면에서 실제로 고를 수 있는 서로 다른 키를 겹치지 않게 차례로 부름(스코어카드 종목×벤치마크×기간,
//           기관 포트폴리오 분기×종목 수, 기관 위험 벤치마크×기간). 목록은 setup()이 /api/stock/universe와
//           /api/sec13f/institutions에서 만들고, hot·rare 키는 뺍니다. RATE=0이면 churn 없이 기준선만 잽니다.
//   health: 1초에 한 번 GET /api/health(인증 없음, 시간 초과 5초 — 백엔드 컨테이너 헬스체크와 같은 값). 비싼 계산이 몰려도
//           health가 답하는지 봅니다(수정 전 RATE=50에서는 20초 안에 답하지 못함). health_ms(지연) · health_ok(200 비율).
//   login : 20초에 한 번 setup()과 같은 EMAIL·PASSWORD·Origin으로 POST /api/auth/login을 하고, 받은 세션은 바로 로그아웃합니다
//           (QA DB에 세션이 쌓이지 않게). login_ms(지연) · login_ok(200 비율). 맞는 비밀번호가 성공하면 LoginThrottle이 그
//           (접속 주소, 이메일)의 실패 기록을 지우므로, setup 로그인 뒤로는 느린 차선(1초 지연, 겹치면 429)을 타지 않습니다. 그래서
//           login_ms는 Argon2id 해시(PasswordHasher — 동시 상한 코어 수·최소 2, 자리 대기 최대 3초)와 세션 저장 시간입니다.
//
// 상태 코드(QA-131): 429는 서버가 덜어 낸 요청(shed)이라 실패로 보지 않습니다 — http.expectedStatuses(200–399, 429)라
//   http_req_failed에도 들지 않습니다. 시나리오마다 shed_hot·shed_rare·shed_churn·shed_login(Counter)으로 세고, 429 응답의 지연은
//   shed_ms입니다(대기열이 가득해 바로 거절되면 수 ms, 자리를 기다리다 거절되면 그 대기 시간만큼). 200도 429도 아닌 응답(5xx·
//   시간 초과·연결 실패·다른 4xx)은 non429_fail(Counter, 임계값 count<1)이고, 요약이 시나리오·종류별로 나눠 보여 줍니다.
//   health는 상한 밖 경로라 429도 실패로 셉니다. login의 실패에는 뒤따르는 로그아웃 요청의 실패도 들어갑니다.
//   DURATION이 끝날 때 아직 진행 중인 요청도 답(또는 시간 초과)까지 기다려 셉니다 — gracefulStop을 요청 시간 초과보다 길게
//   둡니다(scenarios 위 설명).
//   hot·rare의 지연(hot_*·rare_*)과 실패(miss_*) 판정은 예전처럼 200 응답만 봅니다. churn_req는 예전처럼 모든 응답의 지연이고,
//   churn_ok_ms는 200 응답만의 지연입니다.
//
// 캐시에는 적중·실패 카운터가 없어 지연 시간으로 가립니다. setup()이 키마다 한 번 불러 캐시에 올린 뒤 CAL_N번(기본 7) 더
// 불러 적중 지연의 중앙값(warm)을 재고, 문턱 = max(MISS_K × warm, warm + MISS_D)를 넘는 요청을 miss_*(Rate)에 '실패(다시
// 계산)'로 셉니다. 요약은 비율과 건수('1 out of 12' = 12번 읽어 1번 실패)를 함께 보여 줍니다.
//   기본값 MISS_K=3 · MISS_D=20ms: 적중은 동시 50명에서도 p95 5–7ms(docs/qa/evidence/2026-10-18/performance.md)라 중앙값의
//   3배면 적중의 흔들림을 넘고, 20ms는 중앙값이 1–3ms로 작을 때 GC 일시 정지 같은 잡음을 실패로 세지 않게 두는 바닥입니다.
//   둘 다 추정이라 아래 유효성 검사로 확인합니다. 예전처럼 '재시작 직후 첫 요청' 지연(consensus 633–680ms, guru/risk
//   301–320ms, snapshot/text 256–274ms)으로 문턱을 잡으면, 예열 뒤에는 JIT·파싱 캐시가 따뜻해 다시 계산이 문턱보다 빨리
//   끝나 실패를 놓칩니다(거짓 음성). 예열 뒤 다시 계산하는 데 걸리는 시간(S)은 아직 잰 적이 없고, RATE=1 회차의 churn_ok_ms
//   중앙값으로 잽니다(아래 절차).
//   보정이 실패하면(요청이 200이 아님, 또는 적중 중앙값이 fallbackMs 이상 — 적중이 그만큼 느리면 그 키는 캐시에 머물지 못한
//   것) 그 키만 예전의 고정 문턱(fallbackMs: 첫 요청 지연보다 낮게 잡은 값)으로 셉니다. 키별 문턱과 근거는 setup 로그와 요약에 나옵니다.
//   miss_ms_*는 실패로 센 요청의 지연입니다. 다시 계산이면 기준선 회차의 값과 비슷하고, 문턱 바로 위에 몰려 있으면 경합으로
//   느려진 적중입니다. guru/profiles(첫 요청 30ms)·portfolio(13–38ms)는 다시 계산해도 적중과 차이가 작아 참고로만 봅니다.
//
// 유효성 검사(RATE=0 기준선 회차): TTL이 60초라 churn이 없어도 키마다 만료가 약 DURATION/60번 나고(rare 키는 RARE_EVERY의
//   배수로 올림한 주기), 그때마다 실패가 납니다. hot 키는 같은 키를 같은 순간에 읽는 VU가 HOT_VUS/5명(기본 2명)이고 캐시가
//   같은 키의 동시 계산을 하나로 묶지 않아, 만료 한 번에 실패가 그 수만큼 날 수 있습니다. 그래서 기본값으로 120초 회차의
//   실패는 hot 키당 1–5건, rare 키 1–3건이어야 합니다.
//   0건이면 다시 계산이 문턱보다 빠른 것(MISS_K·MISS_D를 낮춤), 훨씬 많으면 적중이 문턱을 넘었거나(높임) 회차 중에 저장본이
//   바뀐 것입니다. 이 검사를 통과하지 못한 MISS_K·MISS_D로 잰 churn 회차는 쓰지 않습니다. 요약(handleSummary)이
//   RATE=0이고 DURATION이 충분할 때(기본값 65초 이상) 키별 기대 범위와 통과 여부를 계산해 보여 줍니다(참고 키
//   profiles·portfolio_nps는 판정에서 뺌).
//   health·login은 기준선 회차에도 돕니다. 2026-10-18 측정(docs/qa/evidence/2026-10-18/cache-churn.md)은 이 둘 없이 잰 것이라
//   조건이 조금 다릅니다(초당 1건·20초에 1건이라 영향은 작다고 봅니다 — 추정).
//   handleSummary가 있으면 k6 기본 요약은 나오지 않아, 요약 끝에 지표 전체를 간단히 함께 찍습니다.
//
// 사용(QA 스택에서만 — 운영 스택 8080에 돌리지 않습니다):
//   bash scripts/qa/qa-stack.sh up && bash scripts/qa/qa-stack.sh restore F=backups/….sql   # .env.qa 기본값: 수집 스케줄 꺼짐
//   k6 run -e BASE=http://127.0.0.1:18082 -e ORIGIN=http://localhost:13002 \
//     -e EMAIL="$(grep ^OWNER_EMAIL= .env.qa | cut -d= -f2-)" -e PASSWORD="$(grep ^APP_PASSWORD= .env.qa | cut -d= -f2-)" \
//     -e RATE=5 -e DURATION=120s scripts/qa/k6/cache-churn.js
//   선택: -e HOT_VUS=10 -e RARE_EVERY=20 -e CAL_N=7 -e MISS_K=3 -e MISS_D=20
//   EMAIL·PASSWORD·ORIGIN은 setup()과 login 시나리오가 함께 씁니다. non429_fail이 1건이라도 있으면 임계값을 넘어 종료 코드가
//   0이 아닙니다(요약은 그래도 나옴).
//
// 절차: 백엔드 재시작(bash scripts/qa/qa-stack.sh compose restart backend) → api-load.js 50명 30초 예열(버림) →
//   RATE 0, 1, 2, 5, 10, 20, 50 각각 120초 × 3회, 중앙값. RATE=0 회차가 유효성 검사를 통과하는지 먼저 봅니다. 회차 앞뒤로
//   저장본 버전이 같은지 봅니다 — 어떤 저장본이든 새로 쓰이면 캐시 전체가 버려져 그 회차는 쓸 수 없습니다:
//     bash scripts/qa/qa-stack.sh exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT max(collected_at) FROM snapshots"'
//   다르면 그 회차는 버리고 .env.qa의 DASHBOARD_READ_MODE=store_only로 다시 띄워 잽니다(조회가 수집을 일으키지 않게).
//   RATE=1 회차의 churn_ok_ms 중앙값(요약의 'churn 200 지연')을 예열 뒤 다시 계산하는 시간 S로 기록합니다. churn 키는 처음
//   부르는 키라 매번 다시 계산이고, 초당 1건이라 계산끼리 거의 겹치지 않습니다(스코어카드·포트폴리오·위험이 섞인 중앙값).
// 판정(제안) — 1차 기준은 실패 건수이고, hot p95는 2차입니다.
//   1차: 키별 실패 건수(3회 중앙값)를 RATE=0 기준선과 비교합니다. RATE≤2에서 기준선보다 키당 1건 넘게 늘면 캐시 구성을 고칠
//     근거가 됩니다. 다만 LRU 산술로는 hot 키(1초 간격)가 밀려나려면 churn이 초당 약 256개는 돼야 하고, rare 키(20초
//     간격)도 RATE≈13(256/20초) 근처에서야 밀리기 시작한다고 봅니다(추정). 그래서 hot 키는 이 시험의 대조군이기도 합니다.
//     rare만 늘면 밀려남이고, hot까지 늘면 먼저 miss_ms_*를 봅니다 — 기준선 회차의 실패 지연과 비슷하면 진짜 다시 계산(캐시가
//     산술대로 움직이지 않음), 문턱 바로 위에 몰려 있으면 경합(churn의 차가운 계산이 같은 JVM의 CPU·GC를 씀)입니다.
//   2차: hot p95는 실패 건수가 늘었을 때 그 영향이 얼마나 큰지 보는 데만 씁니다. 실패 건수는 그대로인데 p95만 오르면 경합이지
//     밀려남이 아니어서, 캐시 구성(크기·접두사별 상한)을 바꿔도 고쳐지지 않습니다.
//   가용성(QA-131): non429_fail이 0인지, health가 모든 탐침에 200으로 답하는지(health_ok·health_ms max), login_ms, 429가 어느
//     시나리오에서 났는지(shed_*)를 봅니다. 429가 churn이 아닌 hot·rare에서 나면 자주 보는 화면도 '새로 읽지 못함'을 겪은 것입니다.
import http from 'k6/http';
import exec from 'k6/execution';
import { sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://127.0.0.1:18082';
const ORIGIN = __ENV.ORIGIN || 'http://localhost:13002';
const RATE = Number(__ENV.RATE || 0);
const DURATION = __ENV.DURATION || '120s';
const HOT_VUS = Number(__ENV.HOT_VUS || 10);
const RARE_EVERY = Number(__ENV.RARE_EVERY || 20);
const CAL_N = Number(__ENV.CAL_N || 7);       // 보정: 첫 요청 뒤 적중 지연을 몇 번 잴지
const MISS_K = Number(__ENV.MISS_K || 3);     // 보정: 문턱 = max(MISS_K × 적중 중앙값, 적중 중앙값 + MISS_D)
const MISS_D = Number(__ENV.MISS_D || 20);    // ms
const TTL_SECONDS = 60;                       // ComputedCache.MAX_AGE_SECONDS
const REQ_TIMEOUT_S = 60;                     // hot·rare·churn·login(로그아웃 포함) 요청의 시간 초과
const HEALTH_TIMEOUT = '5s';                  // docker-compose.yml backend healthcheck timeout
const LOGIN_EVERY_S = 20;
if (!(CAL_N >= 1) || !(MISS_K >= 1) || !(MISS_D >= 0)) throw new Error('CAL_N≥1 · MISS_K≥1 · MISS_D≥0 이어야 합니다');

const NPS = '0001608046';        // 국민연금
const BERKSHIRE = '0001067983';  // 버크셔 해서웨이
const BENCHMARKS = ['SPY', 'QQQ', 'ACWI'];   // 화면의 벤치마크 선택지(Benchmarks.TICKERS)
const YEARS = [1, 2, 3, 5];                  // 화면의 측정 구간 선택지(스코어카드·기관 위험)
const QUARTERS = [1, 2, 4, 8];               // 기관 포트폴리오 화면의 분기 수 선택지
const TOP_N = [10, 20, 30, 50];              // 기관 포트폴리오 화면의 종목 수 선택지

// fallbackMs: 보정이 실패한 키만 쓰는 고정 문턱(재시작 직후 첫 요청 지연보다 낮게 잡은 값). ref: 참고로만 보는 키.
const HOT = [
  { name: 'snapshot_text', path: '/api/snapshot/text', fallbackMs: 100 },
  { name: 'consensus', path: '/api/sec13f/consensus?minHolders=2', fallbackMs: 150 },
  { name: 'risk_nps', path: `/api/guru/risk?cik=${NPS}&benchmark=SPY&years=1`, fallbackMs: 100 },
  { name: 'profiles', path: '/api/guru/profiles', fallbackMs: 20, ref: true },
  { name: 'portfolio_nps', path: `/api/sec13f/portfolio?cik=${NPS}&quarters=8&topN=30`, fallbackMs: 15, ref: true },
];
const RARE = { name: 'risk_berkshire', path: `/api/guru/risk?cik=${BERKSHIRE}&benchmark=QQQ&years=3`, fallbackMs: 100 };

const metrics = {};
for (const k of HOT) {
  metrics[k.name] = { t: new Trend(`hot_${k.name}`, true), miss: new Rate(`miss_${k.name}`), missMs: new Trend(`miss_ms_${k.name}`, true) };
}
metrics[RARE.name] = {
  t: new Trend(`rare_${RARE.name}`, true), miss: new Rate(`miss_rare_${RARE.name}`), missMs: new Trend(`miss_ms_${RARE.name}`, true),
};
const churnTime = new Trend('churn_req', true);
const churnOk = new Trend('churn_ok_ms', true);

// QA-131: 429(서버가 덜어 낸 요청)는 시나리오별로, 그 밖의 실패는 non429_fail 하나에 종류(kind) 태그를 붙여 셉니다.
const shed = {
  hot: new Counter('shed_hot'), rare: new Counter('shed_rare'), churn: new Counter('shed_churn'), login: new Counter('shed_login'),
};
const shedMs = new Trend('shed_ms', true);
const non429Fail = new Counter('non429_fail');
const healthMs = new Trend('health_ms', true);
const healthOk = new Rate('health_ok');
const loginMs = new Trend('login_ms', true);
const loginOk = new Rate('login_ok');
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 429));

const SCENARIOS = ['hot', 'rare', 'churn', 'health', 'login'];
const FAIL_KINDS = [['timeout', '시간 초과'], ['network', '연결 실패'], ['5xx', '5xx'], ['4xx', '4xx(429 외)'], ['other', '기타']];

// gracefulStop: DURATION이 끝날 때 진행 중인 반복은 이 시간까지 기다렸다가 끊기고, 끊긴 반복의 요청은 응답 분포에도
// non429_fail에도(http_reqs에도) 남지 않습니다(k6 v2.3.0에서 확인). 기본값 30초는 요청 시간 초과(60초)보다 짧아, 서버가
// 느린 회차에서 끝 무렵 보낸 요청이 조용히 빠졌습니다. 그래서 시간 초과보다 5초 길게 줘 늦은 200·429·시간 초과도 끝까지
// 셉니다. login은 한 반복에 로그인·로그아웃 두 요청이라 두 배입니다. health는 시간 초과 5초라 기본값으로 충분합니다.
// 정상 회차에서는 반복이 먼저 끝나 실행 시간이 늘지 않고, 서버가 매달리면 회차가 DURATION보다 최대 이 시간만큼 더 걸립니다.
const GRACEFUL_STOP = `${REQ_TIMEOUT_S + 5}s`;
const scenarios = {
  hot: { executor: 'constant-vus', exec: 'hot', vus: HOT_VUS, duration: DURATION, gracefulStop: GRACEFUL_STOP },
  rare: { executor: 'constant-vus', exec: 'rare', vus: 1, duration: DURATION, gracefulStop: GRACEFUL_STOP },
  // 답이 시간 초과(5초)까지 늦어도 1초 간격을 지키도록 VU를 넉넉히 둡니다.
  health: {
    executor: 'constant-arrival-rate', exec: 'health', rate: 1, timeUnit: '1s', duration: DURATION, preAllocatedVUs: 6, maxVUs: 12,
  },
  login: {
    executor: 'constant-arrival-rate', exec: 'login', rate: 1, timeUnit: `${LOGIN_EVERY_S}s`, duration: DURATION,
    preAllocatedVUs: 1, maxVUs: 4, gracefulStop: `${2 * REQ_TIMEOUT_S + 5}s`,
  },
};
if (RATE > 0) {
  scenarios.churn = {
    executor: 'constant-arrival-rate', exec: 'churn', rate: RATE, timeUnit: '1s', duration: DURATION,
    preAllocatedVUs: Math.max(5, RATE * 2), maxVUs: Math.max(20, RATE * 10), gracefulStop: GRACEFUL_STOP,
  };
}

// 시나리오·종류별 하위 지표에도 같은 임계값을 겁니다 — k6는 임계값이 걸린 하위 지표만 요약(handleSummary)에 넘겨 주므로,
// 요약의 응답 분포 표가 이 값을 씁니다. 'scenario' 태그는 k6가 붙입니다.
const thresholds = { non429_fail: ['count<1'] };
for (const s of SCENARIOS) thresholds[`non429_fail{scenario:${s}}`] = ['count<1'];
for (const [kind] of FAIL_KINDS) thresholds[`non429_fail{kind:${kind}}`] = ['count<1'];

export const options = {
  scenarios,
  thresholds,
  summaryTrendStats: ['count', 'med', 'p(95)', 'max'],
};

function get(data, path, name) {
  // 경로마다 시계열이 생기지 않게 name 태그로 묶습니다(churn 키는 수천 개).
  return http.get(`${BASE}${path}`, { cookies: { my_macro_v2_session: data.cookie }, tags: { name }, timeout: `${REQ_TIMEOUT_S}s` });
}

// 실패 종류: 응답이 없으면(status 0) k6 오류 코드로 시간 초과(1050)와 그 밖의 연결 실패를 나눕니다.
function failKind(res) {
  if (res.status === 0) return res.error_code === 1050 ? 'timeout' : 'network';
  if (res.status >= 500) return '5xx';
  if (res.status >= 400) return '4xx';
  return 'other';
}

// 응답 하나를 셉니다: 200이면 true. 429는 shedCounter가 있으면 덜어 낸 요청으로, 없으면(health) 실패로 셉니다.
function tally(res, shedCounter) {
  if (res.status === 200) return true;
  if (res.status === 429 && shedCounter) {
    shedCounter.add(1);
    shedMs.add(res.timings.duration);
    return false;
  }
  non429Fail.add(1, { kind: failKind(res) });
  return false;
}

// 응답이 없을 때(status 0)는 k6 timings가 비어 있을 수 있어, 그때만 직접 잰 시간을 씁니다.
const elapsedMs = (res, startedAt) => (res.status === 0 ? Date.now() - startedAt : res.timings.duration);

function record(data, key, shedCounter) {
  const res = get(data, key.path, key.name);
  if (!tally(res, shedCounter)) return;  // 지연·실패(miss) 판정은 200 응답만
  const m = metrics[key.name];
  const ms = res.timings.duration;
  const miss = ms > data.cal[key.name].missMs;
  m.t.add(ms);
  m.miss.add(miss);
  if (miss) m.missMs.add(ms);
}

function getJson(cookie, path) {
  const res = http.get(`${BASE}${path}`, { cookies: { my_macro_v2_session: cookie } });
  if (res.status !== 200) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

// setup()과 login 시나리오가 같은 계정·Origin으로 로그인합니다.
function postLogin(params) {
  return http.post(`${BASE}/api/auth/login`, JSON.stringify({ email: __ENV.EMAIL || '', password: __ENV.PASSWORD || '' }),
    Object.assign({ headers: { 'Content-Type': 'application/json', Origin: ORIGIN } }, params));
}

const sessionCookie = (res) => (res.cookies.my_macro_v2_session && res.cookies.my_macro_v2_session[0] ? res.cookies.my_macro_v2_session[0].value : null);

// 종류가 섞이게 번갈아 꺼냅니다(스코어카드만 몰리지 않게).
function interleave(lists) {
  const out = [];
  const longest = Math.max(...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

function median(xs) {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const fmt = (x) => (Number.isFinite(x) ? x.toFixed(1) : '—');

// 키 하나의 문턱: 한 번 불러 캐시에 올리고(첫 요청이 다시 계산이어도 됨) CAL_N번 더 불러 적중 지연의 중앙값을 잽니다.
// 중앙값이라 보정 중에 마침 TTL이 끝나 한 번 다시 계산하더라도 흔들리지 않습니다. setup()이 돌려주는 값은 JSON으로 넘어가
// NaN을 담을 수 없어, 모르는 값은 null로 둡니다.
function calibrate(cookie, key) {
  const warmSamples = [];
  let firstMs = null;
  for (let i = 0; i <= CAL_N; i++) {
    const res = http.get(`${BASE}${key.path}`, { cookies: { my_macro_v2_session: cookie }, tags: { name: 'calibrate' }, timeout: '60s' });
    if (res.status !== 200) return { missMs: key.fallbackMs, source: 'fallback', why: `보정 요청이 ${res.status}`, firstMs, warmMs: null };
    if (i === 0) firstMs = res.timings.duration;
    else warmSamples.push(res.timings.duration);
  }
  const warmMs = median(warmSamples);
  if (!(warmMs < key.fallbackMs)) {
    return { missMs: key.fallbackMs, source: 'fallback', why: `적중 중앙값이 고정 문턱 ${key.fallbackMs}ms 이상`, firstMs, warmMs };
  }
  return { missMs: Math.max(MISS_K * warmMs, warmMs + MISS_D), source: 'calibrated', why: '', firstMs, warmMs };
}

export function setup() {
  const res = postLogin({ tags: { name: 'setup_login' } });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  const cookie = sessionCookie(res);
  if (!cookie) throw new Error('no session cookie');

  // 두 목록은 응답 캐시를 거치지 않는 경로라 측정 전에 캐시를 채우지 않습니다.
  const tickers = (getJson(cookie, '/api/stock/universe').rows || []).map((r) => r.ticker).filter(Boolean);
  const ciks = (getJson(cookie, '/api/sec13f/institutions').institutions || []).map((i) => i.cik).filter(Boolean);
  if (tickers.length === 0) throw new Error('스코어카드 종목 목록이 비었습니다 — 백업을 복원했는지 보세요');
  for (const cik of [NPS, BERKSHIRE]) if (!ciks.includes(cik)) throw new Error(`기관 목록에 ${cik}가 없습니다`);

  const fixed = new Set([...HOT.map((k) => k.path), RARE.path]);
  const scorecards = [];
  const portfolios = [];
  const risks = [];
  for (const t of tickers) for (const b of BENCHMARKS) for (const y of YEARS) {
    scorecards.push(`/api/stock/scorecard?symbol=${encodeURIComponent(t)}&benchmark=${b}&years=${y}`);
  }
  for (const c of ciks) {
    for (const q of QUARTERS) for (const n of TOP_N) portfolios.push(`/api/sec13f/portfolio?cik=${c}&quarters=${q}&topN=${n}`);
    for (const b of BENCHMARKS) for (const y of YEARS) risks.push(`/api/guru/risk?cik=${c}&benchmark=${b}&years=${y}`);
  }
  const churn = interleave([scorecards, portfolios, risks]).filter((p) => !fixed.has(p));
  console.log(`churn 키 ${churn.length}개 (스코어카드 ${scorecards.length} · 포트폴리오 ${portfolios.length} · 위험 ${risks.length}, `
    + `hot·rare 제외), RATE=${RATE}/s, DURATION=${DURATION}`);
  if (RATE > 0 && churn.length <= 256) console.warn('churn 키가 캐시 크기(256) 이하라 같은 키가 다시 적중할 수 있습니다');

  const cal = {};
  for (const k of [...HOT, RARE]) {
    const c = calibrate(cookie, k);
    cal[k.name] = c;
    const line = `문턱 ${k.name}: ${fmt(c.missMs)}ms (${c.source === 'calibrated' ? '보정' : `고정 — ${c.why}`}) · `
      + `적중 중앙값 ${fmt(c.warmMs)}ms(${CAL_N}번) · 첫 요청 ${fmt(c.firstMs)}ms`;
    if (c.source === 'calibrated') console.log(line);
    else console.warn(line);
  }
  return { cookie, churn, cal };
}

export function hot(data) {
  record(data, HOT[(__VU + __ITER) % HOT.length], shed.hot);
  sleep(1);
}

export function rare(data) {
  record(data, RARE, shed.rare);
  sleep(RARE_EVERY);
}

export function churn(data) {
  // 시나리오 전체에서 겹치지 않는 반복 번호로 다음 키를 고릅니다 — 목록을 다 돌기 전에는 같은 키를 다시 부르지 않습니다.
  const path = data.churn[exec.scenario.iterationInTest % data.churn.length];
  const res = get(data, path, 'churn');
  churnTime.add(res.timings.duration);
  if (tally(res, shed.churn)) churnOk.add(res.timings.duration);
}

export function health() {
  const startedAt = Date.now();
  const res = http.get(`${BASE}/api/health`, { tags: { name: 'health' }, timeout: HEALTH_TIMEOUT });
  healthMs.add(elapsedMs(res, startedAt));
  healthOk.add(tally(res, null));
}

export function login() {
  const startedAt = Date.now();
  const res = postLogin({ tags: { name: 'login' }, timeout: `${REQ_TIMEOUT_S}s` });
  loginMs.add(elapsedMs(res, startedAt));
  const ok = tally(res, shed.login);
  loginOk.add(ok);
  const cookie = ok ? sessionCookie(res) : null;
  if (cookie) {
    tally(http.post(`${BASE}/api/auth/logout`, null,
      { headers: { Origin: ORIGIN }, cookies: { my_macro_v2_session: cookie }, tags: { name: 'logout' }, timeout: `${REQ_TIMEOUT_S}s` }), null);
  }
}

// k6 기간 문자열('120s', '2m', '1m30s')을 초로. 단위 없는 값처럼 읽을 수 없으면 NaN(유효성 검사를 건너뜀).
function durationSeconds(s) {
  const str = String(s).trim();
  if (!/^(\d+(\.\d+)?(ms|s|m|h))+$/.test(str)) return NaN;
  const unit = { ms: 0.001, s: 1, m: 60, h: 3600 };
  let total = 0;
  for (const m of str.matchAll(/(\d+(\.\d+)?)(ms|s|m|h)/g)) total += Number(m[1]) * unit[m[3]];
  return total;
}

// RATE=0 회차에서 키마다 기대하는 실패 건수 범위: 만료 횟수(DURATION / 만료 주기) × 같은 순간에 읽는 VU 수, 앞뒤로 1건 여유.
// 만료 주기는 hot 키가 TTL(1초마다 읽어 거의 그대로), rare 키는 TTL을 RARE_EVERY의 배수로 올린 값입니다(20초면 60초 = 세 번째 읽기).
const RARE_PERIOD_S = Math.ceil(TTL_SECONDS / RARE_EVERY) * RARE_EVERY;
// 이보다 짧으면 만료 뒤 읽기가 한 번도 없을 수 있어 0건이 정상일 수 있습니다(응답 시간 여유 5초).
const BASELINE_MIN_S = Math.max(TTL_SECONDS, RARE_PERIOD_S) + 5;
function baselineRange(durationS, periodS, readers) {
  const expiries = durationS / periodS;
  return { lo: Math.max(1, Math.floor(expiries) - 1), hi: Math.ceil(expiries) * readers + 1 };
}

// 한글은 터미널에서 두 칸을 차지해, 표가 어긋나지 않게 폭을 세어 채웁니다.
const cellWidth = (s) => [...s].reduce((w, ch) => w + (/[\u1100-\u115f\u3130-\u318f\uac00-\ud7a3]/.test(ch) ? 2 : 1), 0);
const padRight = (s, n) => s + ' '.repeat(Math.max(0, n - cellWidth(s)));
const padLeft = (s, n) => ' '.repeat(Math.max(0, n - cellWidth(s))) + s;
const TABLE = [['키', 24, padRight], ['문턱ms', 8, padLeft], ['근거', 5, padLeft], ['적중ms', 7, padLeft], ['읽음', 6, padLeft],
  ['실패', 5, padLeft], ['실패ms med', 11, padLeft], ['p95ms', 8, padLeft], ['기준선 검사', 0, (x) => `  ${x}`]];
const tableRow = (cells) => `  ${cells.map((c, i) => TABLE[i][2](c, TABLE[i][1])).join('')}`;
const DIST = [['시나리오', 10, padRight], ['200', 8, padLeft], ['429', 8, padLeft], ['실패(429 외)', 14, padLeft]];
const distRow = (cells) => `  ${cells.map((c, i) => DIST[i][2](c, DIST[i][1])).join('')}`;

function metricLine(name, mm) {
  const v = mm.values;
  let text;
  if (mm.type === 'trend') {
    const unit = mm.contains === 'time' ? 'ms' : '';
    const order = (s) => (options.summaryTrendStats.indexOf(s) + 1) || 99;
    text = Object.keys(v).sort((a, b) => order(a) - order(b))
      .map((s) => (s === 'count' ? `count=${v[s]}` : `${s}=${fmt(v[s])}${unit}`)).join(' ');
  } else if (mm.type === 'rate') text = `${(v.rate * 100).toFixed(2)}% ${v.passes} out of ${v.passes + v.fails}`;
  else if (mm.type === 'counter') text = `${v.count} (${fmt(v.rate)}/s)`;
  else text = Object.entries(v).map(([s, x]) => `${s}=${x}`).join(' ');
  const th = Object.entries(mm.thresholds || {}).map(([expr, r]) => `${r.ok ? '✓' : '✗'} ${expr}`).join(' ');
  return `  ${padRight(name, 28)} ${text}${th ? `   [${th}]` : ''}`;
}

// QA-131: 시나리오별 응답 분포, health·login 지연, churn 200 지연(RATE=1이면 S), 429 지연.
function availabilityLines(m) {
  const count = (name) => (m[name] ? m[name].values.count : 0);
  const passes = (name) => (m[name] ? m[name].values.passes : 0);
  const trend = (name, stats) => (m[name] ? stats.map((s) => `${s} ${fmt(m[name].values[s])}`).join(' · ') : '—');
  const fails = (s) => String(count(`non429_fail{scenario:${s}}`));
  const lines = ['응답 분포 — 200 정상 · 429 서버가 덜어 낸 요청(실패 아님, health는 실패로 셈) · 그 밖은 실패(non429_fail, login은'
    + ' 로그아웃 포함):', distRow(DIST.map((c) => c[0]))];
  lines.push(distRow(['hot', String(HOT.reduce((sum, k) => sum + count(`hot_${k.name}`), 0)), String(count('shed_hot')), fails('hot')]));
  lines.push(distRow(['rare', String(count(`rare_${RARE.name}`)), String(count('shed_rare')), fails('rare')]));
  lines.push(distRow(RATE > 0
    ? ['churn', String(count('churn_ok_ms')), String(count('shed_churn')), fails('churn')]
    : ['churn', '—', '—', '—']));
  lines.push(distRow(['health', String(passes('health_ok')), '—', fails('health')]));
  lines.push(distRow(['login', String(passes('login_ok')), String(count('shed_login')), fails('login')]));
  const total = count('non429_fail');
  const kinds = FAIL_KINDS.map(([kind, label]) => `${label} ${count(`non429_fail{kind:${kind}}`)}`).join(' · ');
  lines.push(`  non429_fail ${total}건 ${total === 0 ? '✓' : '✗'} — ${kinds}`);
  lines.push('');
  lines.push(`health (1초마다, 시간 초과 ${HEALTH_TIMEOUT}): ${count('health_ms')}번 중 200 ${passes('health_ok')}번 · `
    + `${trend('health_ms', ['med', 'p(95)', 'max'])} ms`);
  lines.push(`login (${LOGIN_EVERY_S}초마다, 맞는 비밀번호): ${count('login_ms')}번 중 200 ${passes('login_ok')}번 · `
    + `${trend('login_ms', ['med', 'max'])} ms`);
  if (RATE > 0) {
    lines.push(`churn 200 지연: ${count('churn_ok_ms')}건 · ${trend('churn_ok_ms', ['med', 'p(95)', 'max'])} ms`
      + (RATE === 1 ? ' ← RATE=1 회차라 이 중앙값을 예열 뒤 다시 계산 시간 S로 기록합니다' : ''));
  }
  if (count('shed_ms') > 0) {
    lines.push(`429 지연(shed_ms): ${count('shed_ms')}건 · ${trend('shed_ms', ['med', 'p(95)', 'max'])} ms`
      + ' — 바로 거절(대기열 가득)이면 수 ms, 자리를 기다리다 거절이면 그 대기 시간만큼');
  }
  return lines;
}

export function handleSummary(data) {
  const m = data.metrics;
  const cal = (data.setup_data && data.setup_data.cal) || {};
  const durationS = durationSeconds(DURATION);
  const checkBaseline = RATE === 0 && durationS >= BASELINE_MIN_S;
  const lines = [
    `cache-churn 요약 — RATE=${RATE}/s · DURATION=${DURATION} · 문턱 = max(${MISS_K} × 적중 중앙값, 적중 중앙값 + ${MISS_D}ms)`,
    '',
    tableRow(TABLE.map((c) => c[0])),
  ];
  let baselineOk = true;
  for (const k of [...HOT, RARE]) {
    const isRare = k === RARE;
    const t = m[`${isRare ? 'rare' : 'hot'}_${k.name}`];
    const miss = m[isRare ? `miss_rare_${k.name}` : `miss_${k.name}`];
    const missMs = m[`miss_ms_${k.name}`];
    const c = cal[k.name] || {};
    const misses = miss ? miss.values.passes : 0;
    let verdict = '—';
    if (checkBaseline) {
      const { lo, hi } = isRare
        ? baselineRange(durationS, RARE_PERIOD_S, 1)
        : baselineRange(durationS, TTL_SECONDS, Math.ceil(HOT_VUS / HOT.length));
      const ok = misses >= lo && misses <= hi;
      if (!ok && !k.ref) baselineOk = false;
      verdict = `${ok ? '✓' : '✗'} ${lo}–${hi}건${k.ref ? ' (참고 — 판정에서 뺌)' : ''}`;
    }
    lines.push(tableRow([`${k.name}${isRare ? ' (rare)' : ''}${k.ref ? ' (참고)' : ''}`, fmt(c.missMs),
      c.source === 'calibrated' ? '보정' : '고정', fmt(c.warmMs), String(t ? t.values.count : 0), String(misses),
      fmt(missMs ? missMs.values.med : NaN), fmt(t ? t.values['p(95)'] : NaN), verdict]));
  }
  lines.push('');
  if (checkBaseline) {
    lines.push(baselineOk
      ? '기준선 유효 — 실패 건수가 TTL 만료로 기대하는 범위 안입니다. 같은 MISS_K·MISS_D로 churn 회차를 잽니다.'
      : '기준선 무효 — 0건 쪽이면 다시 계산이 문턱보다 빠른 것(MISS_K·MISS_D를 낮춤), 많은 쪽이면 적중이 문턱을 넘었거나'
        + ' 회차 중에 저장본이 바뀐 것(버전 확인·문턱 높임)입니다. 이 문턱으로 잰 churn 회차는 쓰지 않습니다.');
  } else if (RATE === 0) {
    lines.push(`기준선 검사는 DURATION이 ${BASELINE_MIN_S}초 이상일 때만 합니다(그보다 짧으면 만료 뒤 읽기가 없어 0건이 정상일 수 있음).`);
  } else {
    lines.push('실패 건수는 같은 MISS_K·MISS_D로 잰 RATE=0 기준선 회차와 비교합니다(판정 순서는 파일 머리말). hot 실패가 늘면'
      + ' 실패ms med가 기준선의 값과 비슷한지(다시 계산) 문턱 바로 위인지(경합) 봅니다.');
  }
  lines.push('', ...availabilityLines(m));
  lines.push('', '지표 전체:');
  for (const name of Object.keys(m).sort()) lines.push(metricLine(name, m[name]));
  return { stdout: `${lines.join('\n')}\n` };
}
