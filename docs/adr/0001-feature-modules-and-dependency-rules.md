# 0001. 백엔드 기능 단위 패키지와 의존 규칙

- 상태: 채택 (2026-09). 2026-10 개정 — 설정 값(`config`)과 인증 필터·오류 응답 배선(`web`)을 나눠 패키지 순환을 없앰(규칙 6)
- 지키는 방법: `backend/src/test/java/com/macrodash/ArchitectureRulesTest.java`,
  `backend/src/test/java/com/macrodash/web/RouteInventoryTest.java`

## 배경

백엔드는 `service/` 한 패키지에 22개 클래스(인증·AI·매크로·13F·수급·상태, 약 7,100줄)가,
`web/`에 컨트롤러 11개가 평면으로 있었습니다. 기능 사이 의존이 보이지 않았고, 계층도 섞여
있었습니다.

- 순수 계산 패키지(`analytics`)가 JSON 라이브러리(Jackson)를 직접 받음
- 저장소 접근(`store/StoreReader`)이 수집기(`collector`)를 호출
- 컨트롤러 두 곳이 서비스를 건너뛰고 수집기를 직접 호출, 한 곳은 다른 기능의 서비스를 사용
- AI 리포트의 프롬프트 조립 규칙이 컨트롤러 안에 있음

## 결정

기능(메뉴) 단위로 컨트롤러와 서비스를 한 패키지에 모으고, 의존은 바깥에서 안쪽으로만 향하게 합니다.

```
web ─► feature/<기능> ─► read ─► store
             │            └──► collector
             ├──► analytics (java.*만)
             └──► support

config(설정 값) — 기능·read·collector·web이 읽음. config는 우리 패키지를 아무것도 쓰지 않음
```

| 패키지 | 역할 | 쓸 수 있는 것 |
|---|---|---|
| `feature/<기능>` | 컨트롤러(HTTP 경계) + 서비스(응답 조립) | 아래 전부 + 다른 기능의 **서비스** |
| `analytics` | 순수 계산 | `java.*`만 |
| `read` | 읽기 정책(저장본이 오래됐으면 수집 요청). **스냅샷은 여기서만 읽습니다** | store · collector · config |
| `store` | DB 접근 전부(수집기 테이블 읽기 + 백엔드가 쓰는 테이블, [0008](0008-backend-owned-tables-and-scheduled-jobs.md)) · 데이터셋 이름 · 신선도. 기능은 observations·timeseries 조회와 백엔드 소유 테이블에 직접 씁니다. 스프링 JDBC는 `store`에서만 | DB만(수집기·설정·기능 모름) |
| `collector` | 수집기 HTTP 호출 | config |
| `support` | JSON 읽기 · 파라미터 · 비밀값 가림 · 공통 예외 | analytics(입력 타입) |
| `config` | 설정 값(`AppProperties`) · 정기 작업 켜기 | 우리 패키지 없음 |
| `web` | 인증 필터 · CORS(`WebConfig`) · 공통 오류 응답 | 기능까지 |

기능: `auth` · `macro` · `institution` · `insight` · `positioning` · `publicdata` · `status` ·
`snapshot`(전체 원본 텍스트) · `ai` · `toss`

규칙
1. `analytics`는 `java.*`만 씁니다. 저장본 JSON은 `support`에서 일반 타입(record)으로 바꿔 넘깁니다.
2. 컨트롤러는 자기 기능의 서비스와 `support`·`config`만 씁니다(예외: 응답 캐시 `read.ComputedCache` — "같은 저장본이면 같은 응답"은 HTTP 계층의 관심사라 컨트롤러에 두고, 서비스는 캐시를 모른 채 계산만 합니다). 입력 검증(길이·형식)까지가 컨트롤러 몫이고,
   규칙과 조립은 서비스에 둡니다.
3. 기능끼리는 서비스만 가져다 씁니다(컨트롤러는 안 됨). 기능 사이 의존에 순환이 없어야 합니다.
   지금 의존: `ai → snapshot → macro·positioning·institution`. (예전의 `positioning → insight → institution`은
   JSON→시계열 헬퍼를 빌려 쓰려고 생긴 의존이었고, 헬퍼를 `support.Json`으로 옮기며 없어졌습니다.)
4. 새 인터페이스·추상화 계층은 만들지 않습니다. 구현이 하나뿐인 인터페이스는 읽는 비용만 늘립니다.
5. 스냅샷은 `read.StoreReader`로만 읽습니다(`read`·`store` 밖에서 `readSnapshot(` 금지). `StoreRepository`를
   직접 쓰면 "오래됐으면 수집을 요청한다"는 정책이 빠집니다 — 레이더 선택지가 토스 저장본을 그렇게 읽어
   저장본이 낡아도 아무도 새로 받지 않았습니다. observations·timeseries는 신선도 정책이 없어 직접 읽어도 됩니다.
6. 기반 패키지까지 포함해 패키지 사이 순환이 없어야 합니다. 여러 패키지가 읽는 값(설정)과 그 패키지들을 묶는
   배선(필터·오류 응답)은 한 패키지에 두지 않습니다 — 2026-10 jdeps 패키지 그래프에서 `config`가 둘을 함께 들고 있어
   `config ↔ feature.auth`, `config → web → read → collector → config`가 도는 것을 찾았습니다(클래스 단위로는 순환 0).
   배선(`WebConfig`·`ErrorResponseConfig`)을 `web`으로 옮겨 `config`를 잎으로 만들었습니다.

## 이유

- 한 기능을 고칠 때 볼 파일이 한 폴더에 모이고, 기능 사이 의존이 import로 드러납니다.
- 계산이 JSON 라이브러리를 모르면, 라이브러리 교체(Jackson 2 → 3)가 계산 코드와 그 테스트를 건드리지 않습니다.
  실제로 [0002](0002-spring-boot-4-and-jackson-3.md) 전환 때 `analytics`는 한 줄도 바뀌지 않았습니다.
- 저장소 계층이 외부 호출을 하지 않으면, DB만으로 테스트할 수 있고 "화면이 외부를 기다리는가"를 한 곳(`read`)에서 봅니다.

## 대안과 버린 이유

- **계층 단위 패키지 유지(controller/service/repository)**: 기능 22개가 섞인 평면 구조가 문제의 원인이라 그대로 두지 않았습니다.
- **ArchUnit 같은 아키텍처 테스트 라이브러리**: 규칙 6개에 새 의존성을 들일 만큼은 아니라고 봤습니다.
  소스의 import를 읽는 테스트로 충분하고, 위반을 일부러 넣어 규칙마다 실패하는 것을 확인했습니다.
- **설정 값을 새 패키지(`settings`)로 옮기기(규칙 6)**: 순환은 똑같이 없어지지만 `AppProperties`를 읽는 30여 곳의
  import와 허용 표의 이름만 바뀝니다. 배선 두 클래스를 옮기는 쪽이 바뀌는 곳이 적고, 배선은 원래 HTTP 계층(`web`)의 일입니다.
- **마이크로서비스·모듈(Maven 멀티 모듈) 분리**: 한 사람이 운영하는 로컬 앱에서 배포 단위를 늘릴 근거가 없습니다.

## 결과

- `ArchitectureRulesTest`가 규칙 1~3·5·6과 표의 "쓸 수 있는 것"(config·store·collector·support·read)을 빌드마다
  확인합니다(와일드카드 import 포함, 위반하면 "어느 파일 → 무엇" 목록이나 도는 경로로 실패). 기능 사이 순환만 보던
  시험은 기반 패키지를 거쳐 도는 순환을 놓쳤습니다(규칙 6).
- `RouteInventoryTest`가 경로 66개가 그대로인지 고정합니다(컨트롤러를 옮겨도 URL은 바뀌지 않음).
- 공개 범위를 넓힌 것은 1건(`GuruService.closes` — 스코어카드가 씀)뿐입니다.
