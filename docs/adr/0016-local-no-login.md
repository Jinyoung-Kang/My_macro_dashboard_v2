# 0016. 로컬 실행은 로그인 없이 이 맥에서만 — 웹(AWS)은 지금처럼 잠금 화면과 로그인

- 상태: 채택 (2026-10). [ADR 0013](0013-demo-viewer-mode.md)의 "로컬 사용은 지금처럼 로그인이 필요해야 합니다"와
  [ADR 0006](0006-frontend-api-base-at-runtime.md)의 휴대폰·LAN 접속(CORS는 화면 포트의 모든 호스트)을 로컬에서는 대체합니다.
  이 저장소의 AWS는 [ADR 0019](0019-aws-personal-deployment.md) — 잠금 화면 없이 SSM 터널 + 로그인(덧붙임이 `"false"` 고정은 그대로).
- 지키는 방법:
  - `LocalNoLoginTest`: 꺼짐이 기본, 켜졌는데 웹 배포 신호(데모 토큰·`COOKIE_SECURE`·앞단 헤더 신뢰 — 클라우드 플랫폼이 스스로 켜는
    경우 포함·이 맥이 아닌 `FRONTEND_ORIGIN`)가 하나라도 있으면 기동 실패(문구에 값 없음), '이 맥 요청' 판정(Host·프록시 헤더)
  - `LocalOwnerResolveTest`(실제 테스트 DB): 쿠키 → 데모 → 첫 운영자 순서, 운영자 없음은 401, 계정 만들기 재확인은 1분에 한 번,
    첫 운영자를 회원으로 내리면 다음 요청부터 다음 운영자
  - `SessionFilterTest`(로컬 무로그인): 쿠키 없는 GET이 운영자로 닿음, 다른 출처·Origin 없는 쓰기·다른 사이트 GET은 403(운영자 조회 전),
    이 맥이 아닌 Host·프록시 헤더는 401
  - `CorsOriginsTest`: 켜지면 허용 출처가 정확히 `http://{localhost,127.0.0.1,[::1]}:화면 포트`(와일드카드 없음)
  - `AuthControllerTest`: `/api/auth/session`의 `noLogin`·`ownerMissing`·`user.local`
  - `LocalNoLoginIntegrationTest`(@SpringBootTest): 운영 경로까지 운영자로, 쓰기의 `user_id`가 첫 운영자, 다른 출처 403
  - CI(`ci.yml`): 로컬 compose는 화면·API를 127.0.0.1에만 열고 켬, `.env`가 켜려 해도 AWS·QA 덧붙임은 `"false"`
  - `scripts/ports.sh check`: 켜졌는데 `COOKIE_SECURE=true`·외부 `FRONTEND_ORIGIN`이면 `make up`이 빌드 전에 멈춤
  - 화면: `layoutSession.test.tsx`, `accountLocal.test.tsx`, `components/shell/__tests__/Shell.test.tsx`·`MoreMenu.test.tsx`(로컬 운영자는 로그아웃 대신
    '로컬 · 로그인 없음', 쿠키로 로그인한 운영자는 로그아웃 — v2 1단계에서 옛 `Sidebar.test.tsx`의 의도를 옮김), `app/login/__tests__`, `access.test.ts`

## 배경

로컬 대시보드는 한 사람이 자기 맥에서 씁니다. 그런데 열 때마다 이메일·비밀번호 로그인 화면(구버전의 "비밀번호 잠금")이
나왔습니다. 사용자는 잠금 화면을 웹(AWS) 버전에만 두기로 정했습니다(2026-10-19). 웹은 앞단 Caddy의 접근 코드 잠금화면과
데모 열람(ADR 0012·0013)이 그대로입니다.

로그인을 빼면 같은 와이파이의 누구나 운영자 권한(사용자 관리·AI 키 사용·알림 설정)을 갖게 됩니다. Docker Desktop은 모든 접속을
같은 게이트웨이 주소로 보여 줘 "이 맥은 로그인 없이, 휴대폰은 로그인"처럼 접속 주소로 가를 수 없습니다. 그래서 사용자는
**로그인 없음 + 이 맥(127.0.0.1)에서만**을 골랐습니다(휴대폰 접속은 없어짐).

## 결정

1. **스위치 `LOCAL_NO_LOGIN`**(백엔드 `dashboard.local-no-login`). 백엔드 기본값은 **꺼짐**이고, 로컬 `docker-compose.yml`만
   `${LOCAL_NO_LOGIN:-true}`로 켭니다. `compose.aws.yml`과 QA 덧붙임은 보간 없는 `"false"`로 고정해 `.env`가 켜지 못합니다
   (QA에서 시험할 때만 `QA_NO_LOGIN=1`이 `docker-compose.qa-nologin.yml`을 얹음). `make dev-backend`처럼 compose 밖에서 띄우면 꺼진 채입니다.
2. **화면(3000)·API(8080)는 127.0.0.1에만 엽니다**(예전 `WEB_BIND_HOST`는 없앰). 같은 와이파이에서는 닿지 않습니다.
3. **이 맥에서 바로 온 요청만 운영자로 엽니다** — Host가 `localhost`·`127.0.0.1`·`[::1]`이고 앞단 프록시가 붙이는 헤더
   (`X-Forwarded-*`·`Forwarded`·`X-Real-IP`·`Via`·`CF-Connecting-IP`·`True-Client-IP`)와 데모 헤더가 하나도 없을 때.
   순서는 유효한 세션 쿠키 → 데모 열람 헤더 → **첫 운영자 계정**(`role='OWNER'` 중 가장 작은 id)입니다.
   - 실제 계정이라 사용자 번호를 키로 쓰는 쓰기(알림·사용량·감사)가 그대로 맞고, 역할 변경이 다음 요청부터 반영됩니다(캐시 없음).
   - 세션 행·감사 행은 만들지 않습니다(`sessionId` 없음). 운영자가 없으면 기동 때와 같은 계정 만들기를 1분에 한 번만 다시 해 보고,
     그래도 없으면 평소처럼 401 + 화면이 원인 안내(`ownerMissing`).
   - 다른 이름(LAN IP·DNS 리바인딩)으로 온 요청은 평소처럼 로그인이 필요합니다.
4. **쿠키가 없으니 SameSite가 막아 주던 다른 사이트 요청을 직접 막습니다.** 켜져 있으면 허용 출처(CORS·쓰기 검사가 함께 씀)를
   `http://{localhost,127.0.0.1,[::1]}:화면 포트`로 좁히고(로그인 모드의 `http://*:포트` 와일드카드는 뺍니다 — 켜진 상태에서는
   남의 페이지가 운영자 데이터를 읽는 길이 됨), 로컬 운영자 요청은 목록 밖 Origin(모든 메서드)·Origin 없는 쓰기·Origin 없는
   `Sec-Fetch-Site: cross-site`를 403 `bad_origin`으로 끊습니다(운영자 조회 전).
5. **웹 배포 설정과 섞이면 기동하지 않습니다** — 켜져 있는데 데모 토큰, `COOKIE_SECURE=true`, 앞단 헤더 신뢰
   (`server.forward-headers-strategy`, 값이 없어도 클라우드 플랫폼이 스스로 켜는 경우), 이 맥의 http 주소가 아닌
   `FRONTEND_ORIGIN` 중 하나라도 있으면 `IllegalStateException`(값은 문구에 없음). AWS 덧붙임의 고정값·CI 확인과 함께 세 겹입니다.
6. **화면**: 세션 응답의 `noLogin === true`일 때만 이 모드로 봅니다(값이 없는 AWS·예전 백엔드는 로그인). 로그인 화면으로 보내지 않고,
   사이드바는 로그아웃 대신 "로컬 · 로그인 없음", 내 계정은 기기 목록을 숨기고 비밀번호 변경은 웹·QA·복원 백업의 로그인용으로 남깁니다.

## 이유

- 로그인을 빼는 대신 "누가 닿을 수 있는가"를 이 맥으로 좁혔습니다. 바인딩이 1차 방어이고(LAN 공격자는 Host를 꾸밀 수 있음),
  Host·프록시 헤더 검사는 DNS 리바인딩과 실수로 둔 앞단에 대한 2차 방어입니다.
- 데모 열람(ADR 0013)과 같은 자리(`AuthService.resolve`)에 한 단계를 더해, 접근 정책 표·사용자 FK·자기 강등 막기를 그대로 씁니다.
- 기본값을 백엔드에서 끄고 로컬 compose만 켜면, 기반 파일을 덧붙여 쓰는 AWS·QA가 실수로 이어받지 않습니다(고정값으로 끊음).

## 대안과 버린 이유

- **로컬도 로그인 유지 + 세션을 길게**: 잠금 화면이 남아 사용자가 원한 것이 아닙니다.
- **이 맥은 로그인 없이, 휴대폰은 로그인**: Docker Desktop에서 접속 주소로 가를 수 없고 Host 헤더는 위조됩니다.
- **와이파이에도 열기(로그인 없이)**: 같은 네트워크의 누구나 운영자 권한 — 사용자가 고르지 않았습니다.
- **가짜 사용자(데모처럼 번호 -1)**: 알림·사용량·감사가 사용자 FK라 쓰기가 실패합니다. 운영 메뉴도 쓸 수 없습니다.
- **빌드 시점 값(`NEXT_PUBLIC_*`)으로 화면이 판단**: 같은 이미지가 AWS로 가면 그대로 박혀 따라갑니다 — 세션 응답으로만 판단합니다.

## 결과와 남은 위험

- 로컬은 열자마자 대시보드가 나오고 휴대폰 접속은 없어졌습니다. 웹은 그대로입니다.
- 이 맥의 다른 프로세스·브라우저 확장은 Origin을 꾸며 운영자로 부를 수 있습니다(운영자는 AI 하루 한도가 없음). 같은 권한이면
  `.env`의 키를 직접 읽을 수 있다고 보고 받아들입니다.
- 로그인 없는 로컬 스택 앞에 Host를 `127.0.0.1`로 바꾸고 표시 헤더를 붙이지 않는 프록시·터널(nginx 기본 `proxy_pass`, `ssh -R` 등)을
  두면 가를 수 없습니다 — 밖에서 열려면 `LOCAL_NO_LOGIN=false`로 로그인 모드를 쓰세요.
- 쿠키 없이 이 맥에서 API에 쓰는 스크립트·curl은 `Origin: http://localhost:<화면 포트>`가 필요합니다(없으면 403).
- 운영자 계정은 지금처럼 처음 기동 때 `OWNER_EMAIL`·`APP_PASSWORD`로 만듭니다(ADR 0010). 그 값이 없으면 화면이 안내합니다.
