-- 장중 판단 순번 3 예약 닫기와 순번 3 결정 행 세기 — ADR 0031 되돌리기 2단계(코드를 되돌리기 전, 통합 검토 R6·QA-311).
--
-- 옛 코드(장중 판단 최대 2회)는 순번 3인 PLANNED 계획 행을 부르려다 예외를 냅니다(RuleBookService.intradayKind — 순번 1~2만 앎). 그래서 코드를
-- 되돌리기 전에 (1) 설정 intradayMaxPerSession·kr.intradayMaxPerSession을 2로 저장해 새 예약이 순번 3을 쓰지 않게 하고, (2) 이 파일로 남은 순번 3
-- 예약을 SUPERSEDED로 닫은 뒤, (3) 코드를 되돌려 배포합니다. V27(순번 1~3·INTRADAY_3·출처 칸)은 더하기만이라 그대로 둡니다.
--
-- 순번 3 결정 행(kind INTRADAY_3)은 지우거나 종류를 바꾸지 않습니다 — 실험 기록이고 주문·체결이 그 행을 가리킵니다(CHECK·UNIQUE(book, d, kind)로
-- 다른 종류에 옮길 자리도 없음). 그런데 옛 코드(7d166f4a)는 장중 판단 종류를 INTRADAY_1·INTRADAY_2로만 알아(RuleBookService.intraday) 이 행을
-- 정기 결정으로 읽습니다 — 다음 결정 패킷의 직전 결정(PacketBuilder.priorDecisionKind: 같은 d의 아침 결정보다 늦어 맨 앞에 오고, 자세·watchlist가
-- 없는 응답이라 10_recentDecisions에 빈 줄·8b watchlist가 빔), 주간 복기의 결정(host), 실행 기록의 메뉴 줄(ExecutionView), 계좌2 소상한
-- (ClaudeBookService.claude2CallsInCycle — 덜 셈). 그래서 이 파일 끝의 SELECT가 계좌별 INTRADAY_3 결정 행 수를 보여 줍니다. 한 줄이라도 나오면 (3)의
-- revert 커밋에 호환 줄을 함께 넣습니다(ADR 0031 '되돌리기'): RuleBookService.intraday를 kind != null && kind.startsWith("INTRADAY_")로(패킷의 직전
-- 결정·주간 복기가 이것을 씀), ExecutionView의 장중 판단 종류 목록과 claude2CallsInCycle의 종류 목록에 "INTRADAY_3"을 더함(INTRADAY_MAX·
-- intradayKind는 2 그대로). 0줄이면 그대로 되돌려도 됩니다.
--
-- 바꾸는 것은 순번 3이고 상태가 PLANNED인 계획 행뿐입니다. 끝난 행(DONE·EXPIRED·SKIPPED·SUPERSEDED)과 순번 1·2, 결정 행(INTRADAY_3 포함)은 그대로이고,
-- 여러 번 돌려도 같습니다(두 번째부터 0행, SELECT는 같은 결과). 쓰는 표는 백엔드 표(paper_intraday_plans)이고, 이 파일은 운영자가 손으로 한 번 돌립니다.
--
-- 실행(그 서버의 저장소 최상위에서 — 운영 DB에 쓰는 명령이라 사용자 확인 뒤에):
--   docker compose exec -T postgres sh -c 'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < scripts/rollback/intraday-slot3.sql
-- 작은따옴표 안의 변수는 서버 셸이 아니라 컨테이너 안의 sh가 compose가 넣은 POSTGRES_USER·POSTGRES_DB로 풉니다(scripts/vultr/deploy.sh와 같은 꼴 —
-- 서버 셸은 .env를 읽지 않아 $DATABASE_USER·$DATABASE_NAME으로 쓰면 빈 값이 되고 psql이 role "root"로 붙어 실패함, QA-332).
-- 시험: backend PaperStoreDbTest.rollbackClosesSlotThreePlans·rollbackCountsSlotThreeDecisions(테스트 DB에서 이 파일을 그대로 돌림).
UPDATE paper_intraday_plans
   SET status = 'SUPERSEDED',
       reason = 'ROLLBACK — 장중 판단 순번 3 예약을 코드 되돌리기 전에 닫음(ADR 0031)',
       updated_at = now()
 WHERE slot = 3
   AND status = 'PLANNED';

-- 남는 순번 3 결정 행(계좌별) — 한 줄이라도 있으면 revert 커밋에 호환 줄(위 머리말)을 함께 넣습니다.
SELECT book_code,
       count(*)                AS intraday3_decisions,
       min(as_of_trading_date) AS first_as_of,
       max(as_of_trading_date) AS last_as_of
  FROM paper_decisions
 WHERE kind = 'INTRADAY_3'
 GROUP BY book_code
 ORDER BY book_code;
