import { describe, expect, it } from "vitest";

import {
  consensusKpis,
  consensusKpisPending,
  consensusRowItems,
  filerBadges,
  institutionChoices,
  newBuyRowItems,
  participantsLine,
  securityTitles,
  selectionCountText,
} from "@/lib/consensusScreen";
import type { ConsensusRow } from "@/lib/types";

const FLAG = "🇰🇷 국민연금 (National Pension Service)";
const KRW = { toKrw: (usd: number | null | undefined) => (usd === null || usd === undefined ? null : `약 ${usd * 1000}원`), note: "원/달러 1,000.00 기준" };
const NO_KRW = { toKrw: () => null, note: "원/달러 값이 없어 원화 환산은 생략했습니다." };

const row = (over: Partial<ConsensusRow> = {}): ConsensusRow => ({
  key: "cusip:037833100", name: "APPLE INC", cusip: "037833100", holders: [FLAG, "Berkshire"], actions: [], holderCount: 2,
  totalValue: 2_000_000_000, avgWeight: 5.25, maxWeight: 9.1, buyCount: 1, sellCount: 0, ...over,
});

/** 속성 줄을 '이름 → 값' 표로(보조 글이 있으면 '값 | 보조 글'). */
function table(items: { label: string; value: string | number | null; note?: string | null }[]): Record<string, string> {
  return Object.fromEntries(items.map((item) => [item.label, `${item.value ?? "null"}${item.note ? ` | ${item.note}` : ""}`]));
}

describe("교집합 화면 — 거르기 목록", () => {
  it("기관 줄은 CIK가 키, 이름은 국기를 뗀 이름(비면 'CIK …'), 받은 차례 그대로", () => {
    expect(institutionChoices([{ cik: "0001608046", name: FLAG }, { cik: "0000000001", name: "" }])).toEqual([
      { key: "0001608046", label: "국민연금 (National Pension Service)" },
      { key: "0000000001", label: "CIK 0000000001" },
    ]);
    expect(institutionChoices(undefined)).toEqual([]);
  });

  it("개수는 '고른 수곳 / 전체곳', 전체를 모르면 null", () => {
    expect(selectionCountText(12, 12)).toBe("12곳 / 12곳");
    expect(selectionCountText(3, 12)).toBe("3곳 / 12곳");
    expect(selectionCountText(0, 0)).toBeNull();
  });
});

describe("교집합 화면 — KPI 띠", () => {
  it("참여 기관·교집합 종목·교집합 기준 분기 — 출처 줄은 첫 타일에만, 기준 분기가 없으면 판정 글 '각 기관 최신'", () => {
    const tiles = consensusKpis({ participantCount: 12, rows: [row(), row({ key: "cusip:2" })], reportDate: null }, "SEC 13F");
    expect(tiles.map((tile) => [tile.label, tile.value, tile.unit ?? null, tile.source ?? null, tile.valueKind ?? "number"])).toEqual([
      ["참여 기관", 12, "곳", "SEC 13F", "number"],
      ["교집합 종목", 2, "개", null, "number"],
      ["교집합 기준 분기", "각 기관 최신", null, null, "label"],
    ]);
    expect(tiles[0].format?.(1234)).toBe("1,234");
    expect(consensusKpis({ participantCount: 3, rows: [], reportDate: "2026-06-30" }, "S")[2]).toMatchObject({ value: "2026-06-30" });
  });

  it("참여 기관 수가 숫자가 아니면 null('—') — 0으로 채우지 않음", () => {
    const tiles = consensusKpis({ participantCount: Number.NaN, rows: [], reportDate: null }, "S");
    expect(tiles[0].value).toBeNull();
    expect(tiles[1].value).toBe(0);
  });

  it("읽는 중 타일 셋은 자리표시이고 첫 타일만 출처 글", () => {
    const tiles = consensusKpisPending("SEC 13F");
    expect(tiles.map((tile) => [tile.label, tile.pending, tile.source ?? null])).toEqual([
      ["참여 기관", true, "SEC 13F"],
      ["교집합 종목", true, null],
      ["교집합 기준 분기", true, null],
    ]);
  });
});

describe("교집합 화면 — 검사 칸", () => {
  it("줄 이름표는 이름이 겹치는 줄에만 증권 구분자(QA-114), 그래도 겹치면 행 키", () => {
    const titles = securityTitles([
      { key: "cusip:02079K305", name: "ALPHABET INC", cusip: "02079K305" },
      { key: "cusip:02079K107", name: "ALPHABET INC", cusip: "02079K107" },
      { key: "issuer:084670", name: "BERKSHIRE HATHAWAY INC DEL", cusip: "084670702" },
      { key: "name:a", name: "SAME", cusip: null },
      { key: "name:b", name: "SAME", cusip: null },
    ]);
    expect([...titles.values()]).toEqual([
      "ALPHABET INC · CUSIP 02079K305",
      "ALPHABET INC · CUSIP 02079K107",
      "BERKSHIRE HATHAWAY INC DEL",
      "SAME",
      "SAME · name:b",
    ]);
  });

  it("교집합 줄의 속성 — 기관 수는 'n곳', 비중은 13F 비중 글, 평가액과 원화 환산(보조 글 = 환율 문구)", () => {
    expect(table(consensusRowItems(row({ key: "issuer:02079K", name: "ALPHABET INC", cusip: "02079K305", avgWeight: 0.003 }), KRW))).toEqual({
      "공시 이름": "ALPHABET INC",
      "증권 구분": "발행사 02079K · 보통주 합산",
      "보유 기관 수": "2곳",
      "동시 매수": "1곳 | 직전 분기보다 새로 사거나(신규 매수) 늘린(비중 확대) 기관 수",
      "동시 매도": "0곳 | 직전 분기보다 줄이거나(비중 축소) 모두 판(전량 매도) 기관 수",
      "평균 비중": "<0.01%",
      "최대 비중": "9.10%",
      "합산 평가액": "20.0억 달러",
      "원화 환산": "약 2000000000000원 | 원/달러 1,000.00 기준",
    });
  });

  it("모르는 값은 null('—') — 평가액·비중·환율", () => {
    const items = table(consensusRowItems(row({ totalValue: null, avgWeight: null, maxWeight: null, cusip: "" }), NO_KRW));
    expect(items["증권 구분"]).toBe("null");
    expect(items["평균 비중"]).toBe("null");
    expect(items["최대 비중"]).toBe("null");
    expect(items["합산 평가액"]).toBe("null");
    expect(items["원화 환산"]).toBe("null | 원/달러 값이 없어 원화 환산은 생략했습니다.");
  });

  it("공통 신규 매수 줄의 속성 — 새로 담은 기관 수·평균 비중·평가액·원화·기준 분기", () => {
    expect(table(newBuyRowItems({ key: "cusip:1", name: "NEW CO", cusip: "000000001", buyers: ["A"], buyerCount: 3, totalValue: 100, avgWeight: 0.8,
      reportDate: "2026-06-30" }, KRW))).toEqual({
      "공시 이름": "NEW CO",
      "증권 구분": "CUSIP 000000001",
      "새로 담은 기관 수": "3곳",
      "평균 비중": "0.80%",
      "합산 평가액": "100 달러",
      "원화 환산": "약 100000원 | 원/달러 1,000.00 기준",
      "기준 분기": "2026-06-30",
    });
  });

  it("기관 배지는 국기를 뗀 전체 이름, 참여 기관 줄은 국기를 뗀 이름(없으면 '—')", () => {
    expect(filerBadges([FLAG, "Berkshire Hathaway"])).toEqual([
      { key: FLAG, name: "국민연금 (National Pension Service)" },
      { key: "Berkshire Hathaway", name: "Berkshire Hathaway" },
    ]);
    expect(participantsLine([FLAG, "Berkshire"])).toBe("참여 기관: 국민연금 (National Pension Service), Berkshire");
    expect(participantsLine([])).toBe("참여 기관: —");
  });
});
