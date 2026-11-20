/**
 * 수급 레이더 재무 비율·배수의 음수 부호 — QA-889(D6 전 QA 스택 확인에서 찾음, 작업대 P7).
 *
 * 순위 검사 칸(RankingDetail — P7 새 칸) '재무'의 ROE·PER·PBR·부채비율과 재무 표(FundamentalsPanel — P7에서 공용 조밀 표로 옮김)의 영업이익률·ROE·
 * 부채비율·PER·PBR이 formatNumber 결과를 그대로 '%'·'배'에 붙여 음수가 ASCII 하이픈('-2.5%')이었습니다. 같은 검사 칸의 순매수대금·누적 주식 수와
 * 변화 칩은 U+2212('−')라 한 칸 안에서 음수 부호 글자가 섞였습니다(QA 자료 삼성SDI ROE −2.5%·영업이익률 −13.0%).
 *
 * 기대: 부호 있는 비등락 값은 본문 잉크 + U+2212(P7 규칙 '부호 있는 값은 잉크와 −') — 양수는 부호 없이 그대로, 모르면 '—'(0으로 채우지 않음).
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 첫 사례 "expected [ '-2.5%', '-3.4배', '0.8배' ] to deeply equal [ '−2.5%', '−3.4배', '0.8배' ]",
 * 둘째 사례 "expected [ '-13.0%', '-2.5%', '-3.4배' ] to deeply equal [ '−13.0%', '−2.5%', '−3.4배' ]".
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { KrFundamentalsCompany, KrFundamentalsResponse, RadarRow } from "@/lib/types";
import type { ConsensusRead } from "../radar/ConsensusPanel";
import type { StockFlowsRead } from "../radar/FlowPanels";
import { FundamentalsPanel, type FundamentalsRead } from "../radar/FundamentalsPanel";
import { RankingDetail } from "../radar/RankingDetail";

afterEach(() => cleanup());

const ROW = { rank: 1, code: "000001", name: "합성전지", price: 71000, changePct: -1.2, netAmountEok: -10 } as RadarRow;
const COMPANY: KrFundamentalsCompany = {
  code: "000001", available: true, name: "합성전지", bsnsYear: "2025", fsLabel: "연결", capitalImpaired: false, debtRatio: 85.2, roe: -2.5,
  operatingMargin: -13.0, revenueGrowth: -20.0, operatingIncomeGrowth: null, operatingTurn: "적자전환", marketCap: 1.2e13, per: -3.4, pbr: 0.8,
};

function read<T>(data: unknown): T {
  return { data, loading: false, error: null, refreshError: null, reload: async () => {} } as unknown as T;
}
const FUNDAMENTALS: KrFundamentalsResponse = { available: true, priceDate: "2026-11-18", companies: [COMPANY] };

/** 속성 목록 한 줄의 값(dd) 글. */
function property(scope: HTMLElement, label: string): string {
  const term = within(scope).getAllByText(label).find((element) => element.tagName === "DT");
  if (!term) throw new Error(`속성 '${label}' 없음`);
  return term.nextElementSibling?.textContent ?? "";
}

describe("수급 레이더 재무 비율·배수의 음수 부호(QA-889)", () => {
  it("검사 칸 '재무': ROE·PER 음수는 −(U+2212), 양수(PBR·부채비율)는 부호 없이", () => {
    const { container } = render(
      <RankingDetail
        row={ROW}
        tradeType="순매도"
        source={null}
        flows={read<StockFlowsRead>({ stocks: [] })}
        fundamentals={read<FundamentalsRead>(FUNDAMENTALS)}
        consensus={read<ConsensusRead>({ rows: [] })}
      />,
    );
    const shown = ["ROE", "PER", "PBR"].map((label) => property(container, label));
    expect(shown).toEqual(["−2.5%", "−3.4배", "0.8배"]);
    expect(property(container, "부채비율")).toBe("85.2%");
    expect(container.textContent).not.toMatch(/(^|[^\d])-\d/);
  });

  it("재무 표: 영업이익률·ROE·PER 음수는 −(U+2212)", () => {
    render(<FundamentalsPanel codes={["000001"]} fundamentals={read<FundamentalsRead>(FUNDAMENTALS)} />);
    const table = screen.getByRole("table");
    const headers = within(table).getAllByRole("columnheader").map((cell) => cell.textContent);
    const row = within(table).getAllByRole("row")[1];
    const at = (header: string) => ([...row.children] as HTMLElement[])[headers.indexOf(header)]?.textContent ?? "";
    expect(["영업이익률", "ROE", "PER"].map(at)).toEqual(["−13.0%", "−2.5%", "−3.4배"]);
    expect(at("PBR")).toBe("0.8배");
    expect(table.textContent).not.toMatch(/(^|[^\d])-\d/);
  });
});
