# 공공 API 응답 표본

테스트가 쓰는 응답 파일과 그 출처입니다. **지어낸 응답은 넣지 않습니다.**
출처를 적을 수 없는 파일은 여기 두지 않습니다.

| 파일 | 출처 | 비고 |
|---|---|---|
| `kasi_getRestDeInfo_2026.xml` | 한국천문연구원 특일정보 `getRestDeInfo?solYear=2026` 실제 응답 | [lunalism/holidays](https://github.com/lunalism/holidays) `sources/kr/cache/` 관측본 (2026-08) |
| `kasi_getRestDeInfo_2029_empty.xml` | 같은 API, 아직 발표되지 않은 해 | resultCode 00 + totalCount 0 (정상 봉투, 항목 없음) |
| `datagokr_error_not_registered.xml` | 공공데이터포털 게이트웨이 오류 봉투 | 등록되지 않은 키 → HTTP 403 |
| `datagokr_error_key_null.xml` | 같은 오류 봉투 | 빈 키 → HTTP 401 |
| `fsc_getStockPriceInfo_V2_guide_sample.xml` | 금융위원회_주식시세정보 오픈API 활용가이드의 `getStockPriceInfo_V2` 응답 예시 | 공식 문서 예시. `fltRt`가 `.47`처럼 앞자리 0 없이 옴 |
| `fsc_getStockPriceInfo_V2_halted_101530.xml` | 같은 API 실제 응답 — `basDt=20261023&likeSrtnCd=101530`(2026-10-27 06:2x KST 조회, HTTP 200, 본문 그대로) | 거래가 없던 종목(거래량 0): `mkp`·`hipr`·`lopr`가 `0`, `clpr`은 직전 종가 |

실제 인증키는 어떤 파일에도 들어 있지 않습니다.

## 표본이 없는 API

DART는 이 개발 환경에서 해당 서버에 접속할 수 없어 실제 응답을 받지 못했습니다
(연결 진단에서는 실제 호출이 성공했습니다). 테스트는 **공식 문서 또는 실제로 동작하는
오픈소스 코드가 읽는 필드 이름**만으로 최소 응답을 구성하고, 각 테스트 파일
머리에 그 근거를 적었습니다. 실제 응답을 받으면 이 폴더에 추가하고 표에 적으세요.
