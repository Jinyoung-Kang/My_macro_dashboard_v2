-- 장중 판단 순번 3 예약 닫기 — ADR 0031 되돌리기 2단계(코드를 되돌리기 전, 통합 검토 R6).
--
-- 옛 코드(장중 판단 최대 2회)는 순번 3인 PLANNED 계획 행을 부르려다 예외를 냅니다(RuleBookService.intradayKind — 순번 1~2만 앎). 그래서 코드를
-- 되돌리기 전에 (1) 설정 intradayMaxPerSession·kr.intradayMaxPerSession을 2로 저장해 새 예약이 순번 3을 쓰지 않게 하고, (2) 이 파일로 남은 순번 3
-- 예약을 SUPERSEDED로 닫은 뒤, (3) 코드를 되돌려 배포합니다. V27(순번 1~3·INTRADAY_3·출처 칸)은 더하기만이라 그대로 둡니다.
--
-- 바꾸는 것은 순번 3이고 상태가 PLANNED인 행뿐입니다. 끝난 행(DONE·EXPIRED·SKIPPED·SUPERSEDED)과 순번 1·2, 결정 행(INTRADAY_3 포함)은 그대로이고,
-- 여러 번 돌려도 같습니다(두 번째부터 0행). 쓰는 표는 백엔드 표(paper_intraday_plans)이고, 이 파일은 운영자가 손으로 한 번 돌립니다.
--
-- 실행(그 서버의 저장소 최상위에서 — 운영 DB에 쓰는 명령이라 사용자 확인 뒤에):
--   docker compose exec -T postgres psql -U "$DATABASE_USER" -d "$DATABASE_NAME" -v ON_ERROR_STOP=1 < scripts/rollback/intraday-slot3.sql
-- 시험: backend PaperStoreDbTest.rollbackClosesSlotThreePlans(테스트 DB에서 이 파일을 그대로 돌림).
UPDATE paper_intraday_plans
   SET status = 'SUPERSEDED',
       reason = 'ROLLBACK — 장중 판단 순번 3 예약을 코드 되돌리기 전에 닫음(ADR 0031)',
       updated_at = now()
 WHERE slot = 3
   AND status = 'PLANNED';
