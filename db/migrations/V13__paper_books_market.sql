-- =============================================================================
-- V13__paper_books_market.sql
-- 모의 매매 계좌(paper_books)에 시장·통화 열을 더합니다(v2 결정 V7 — 기존 계좌는 "모의 알고리즘 매매(미국)").
--
-- - market은 그 계좌가 거래하는 시장(US · KR), currency는 장부 통화(USD · KRW)입니다. 지금 계좌 네 개(rules·claude·bench_spy·
--   bench_mix)는 모두 미국·달러라 기본값이 그대로 들어갑니다. 한국 책(2단계, docs/specs/2026-10-26-v2-kr-paper-spec.md)이 KR·KRW 계좌를
--   만들 때 씁니다 — 지금 백엔드는 이 열을 쓰지 않습니다.
-- - 계좌 코드·다른 테이블은 그대로입니다(코드는 시장마다 겹치지 않게 kr_ 접두어를 씀).
-- - 여러 번 실행해도 안전합니다(make db-test는 파일마다 매번 다시 실행).
-- - 쓰는 곳은 백엔드 store.PaperStore뿐입니다(ADR 0008).
-- =============================================================================

ALTER TABLE paper_books ADD COLUMN IF NOT EXISTS market TEXT NOT NULL DEFAULT 'US' CHECK (market IN ('US', 'KR'));
ALTER TABLE paper_books ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'KRW'));
