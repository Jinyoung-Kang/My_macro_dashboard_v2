/**
 * QA-818 — 한국 Claude 결정 상세의 '남긴 조건' 표가 종목 칸에 종목 코드('000660')를, 조건 칸에 다듬지 않은 원 단위 기준값('price < 180000')을 보이던
 * 결함(개편 전부터 — D5 전 QA 스택 한국 결정 로그, 합성 결정). 같은 상세의 제안 주문·검증·관찰 목록 표는 기업명이고(사용자 결정 2026-11-02 — 이름 표의
 * TickerName), 한국 화면의 원 금액은 천 단위로 끊습니다. 종목 칸은 이름 표를 따르고(이름을 모르면 코드 그대로, 계좌 전체 조건은 '—'), 기준값은 천 단위
 * 구분(소수는 받은 자리 그대로 — 'us10y > 5.1')이어야 합니다. 값은 모두 합성 값입니다.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ClaudeDecisionBody } from "@/components/screens/paper/ClaudeDecisionBody";
import { TickerNamesProvider } from "@/hooks/useTickerNames";
import { claudeDecisionView } from "@/lib/paper";

afterEach(() => cleanup());

const RESPONSE = {
  stance: "합성 판단", summary: "합성 요약", targetEquityExposurePct: 60, orders: [], watchlist: [],
  conditions: [
    { metric: "price", op: "BELOW", level: 180000, ticker: "000660", then: "무효화 — 전량 매도 검토" },
    { metric: "us10y", op: "ABOVE", level: 5.1, then: "노출 축소 검토" },
  ],
};

describe("QA-818 — 남긴 조건 표의 종목은 이름 표를 따르고 기준값은 천 단위로", () => {
  it("한국 결정: 종목 칸 'SK하이닉스'(코드는 title), 조건 'price < 180,000', 소수 기준값은 그대로", () => {
    const view = claudeDecisionView({ book: "kr_claude", status: "OK", response: RESPONSE });
    render(
      <TickerNamesProvider names={{ "000660": "SK하이닉스" }}>
        <ClaudeDecisionBody view={view} />
      </TickerNamesProvider>,
    );
    const table = screen.getByRole("table", { name: "남긴 조건" });
    const rows = within(table).getAllByRole("row").slice(1).map((row) => [...row.children].map((cell) => cell.textContent));
    expect(rows).toEqual([
      ["SK하이닉스", "price < 180,000", "무효화 — 전량 매도 검토"],
      ["—", "us10y > 5.1", "노출 축소 검토"],
    ]);
    expect(within(table).getByText("SK하이닉스").getAttribute("title")).toBe("000660");
  });
});
