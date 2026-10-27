-- =============================================================================
-- V15__paper_positions_fill_ref_volume.sql
-- 한국 보유가 반영한 마지막 관측('since' 봉)의 토스 원시 거래량(2단계 명세 docs/specs/2026-10-26-v2-kr-paper-spec.md §4-2
-- 'B7 구현에서 정한 것'의 since 계약, 결정 d12 — C2c).
--
-- - paper_positions.fill_ref_volume: 한국 보유의 since 봉(fill_ref_date·fill_ref_close와 같은 봉 — 그 보유 수량이 반영한 마지막
--   관측, 거래량 > 0 봉)의 토스 원시 거래량. 장부가 기업행위 판정(analytics.KrxCorporateActions.assess)에 저장본의 최근 5봉과 함께
--   이 봉을 이어 붙여 넘깁니다 — 정지 4봉 + 재상장 봉처럼 비율이 바뀌기 전 마지막 관측이 5봉 창 밖이어도 3중 조건(가격비·거래량비·
--   순자산 연속성)을 봅니다. 거래량비는 토스 거래량 한 출처로만 재므로(금융위 거래량은 NXT 종목에서 약 1.7배 다름 — 섞지 않음)
--   금융위 값으로 대신하지 않고 이 칸을 둡니다. 수집기 계약(paper.kr.quotes 계약 1)은 그대로입니다.
-- - NULL = 모름(미국 행·이 열 전의 한국 행). 0으로 채우지 않습니다 — since 봉은 관측(거래량 > 0)이라 0이 올 수 없어 CHECK > 0.
-- - 쓰는 곳은 백엔드 store.PaperStore뿐입니다(ADR 0008, collector/tests/test_table_ownership.py). upsertPosition은 이 열을 쓰지
--   않습니다(미국 보유 경로·고정본 그대로 — corp_action_hold와 같은 방식). 한국 장부가 따로 씁니다. 백엔드는 이 열로
--   "스키마 준비됨"을 봅니다(PaperStore.ready).
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행): 열이 이미 있으면 ADD COLUMN IF NOT EXISTS가 CHECK까지
--   통째로 건너뜁니다.
-- =============================================================================

ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS fill_ref_volume BIGINT CHECK (fill_ref_volume > 0);
