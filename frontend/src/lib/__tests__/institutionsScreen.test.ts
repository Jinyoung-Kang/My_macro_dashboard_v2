/**
 * 13F 포트폴리오 화면 모델(lib/institutionsScreen) — 기관 목록 줄·고른 기관 제목·요약 KPI·비중 추이 선·보유 표 줄 키·이름표·검사 칸 속성.
 */
import { describe, expect, it } from "vitest";

import { formatCurrency } from "../format";
import {
  holdingInspectorItems,
  holdingRowKeys,
  holdingRowLabels,
  institutionItems,
  institutionTitle,
  portfolioKpis,
  WEIGHT_LINE_LABEL_WIDTH,
  weightLines,
} from "../institutionsScreen";
import type { Holding, PortfolioResponse } from "../types/institution";

describe("institutionItems", () => {
  it("키는 CIK, 이름은 국기를 뗀 글, 설명은 그대로 — 받은 차례", () => {
    expect(
      institutionItems([
        { key: "brk", name: "\u{1F1FA}\u{1F1F8} 가상 버크셔 (Fictional Berkshire)", cik: "0001067983", desc: "합성 설명" },
        { key: "nps", name: "가상 연기금", cik: "0001608046", desc: "" },
      ]),
    ).toEqual([
      { key: "0001067983", label: "가상 버크셔 (Fictional Berkshire)", desc: "합성 설명" },
      { key: "0001608046", label: "가상 연기금", desc: "" },
    ]);
  });

  it("이름이 비거나 기호뿐이면 'CIK …'(이름을 지어내지 않음), 목록이 없으면 빈 목록", () => {
    expect(institutionItems([{ key: "x", name: "\u{1F1EF}\u{1F1F5}", cik: "0000000001", desc: "" }])[0].label).toBe("CIK 0000000001");
    expect(institutionItems([{ key: "y", name: "", cik: "0000000002", desc: "" }])[0].label).toBe("CIK 0000000002");
    expect(institutionItems(null)).toEqual([]);
    expect(institutionItems(undefined)).toEqual([]);
  });
});

describe("weightLines", () => {
  const COLORS = ["c0", "c1", "c2"];

  it("상위 10줄만, 키 차례 그대로, 색은 받은 목록을 차례대로 돌려 씀", () => {
    const series = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`NAME ${index}`, [index]]));
    const lines = weightLines(series, COLORS);
    expect(lines.map((line) => line.key)).toEqual(Array.from({ length: 10 }, (_, index) => `NAME ${index}`));
    expect(lines.map((line) => line.color)).toEqual(["c0", "c1", "c2", "c0", "c1", "c2", "c0", "c1", "c2", "c0"]);
  });

  it("이름이 같은 줄의 구분자(클래스·CUSIP)는 이름표에 남고 이름표가 서로 다르다(QA-120)", () => {
    const keys = ["WELLS FARGO & CO · COM", "WELLS FARGO & CO · PERP PFD CNV A", "ISHARES TR · CUSIP 464287200", "ISHARES TR · CUSIP 464287655"];
    const lines = weightLines(Object.fromEntries(keys.map((key) => [key, [1]])), COLORS);
    const names = lines.map((line) => line.name);
    expect(new Set(names).size).toBe(keys.length);
    expect(names[0]).toMatch(/ · COM$/);
    expect(names[1]).toMatch(/ · PERP PFD CNV A$/);
    expect(names[2]).toContain("464287200");
    expect(names[3]).toContain("464287655");
  });

  it("짧은 이름은 그대로, 이름표 폭은 예전 '앞 18자 + …'와 같은 19", () => {
    expect(WEIGHT_LINE_LABEL_WIDTH).toBe(19);
    expect(weightLines({ "APPLE INC": [1] }, COLORS)[0].name).toBe("APPLE INC");
  });

  it("비중 이력이 없으면 빈 목록", () => {
    expect(weightLines(undefined, COLORS)).toEqual([]);
    expect(weightLines({}, COLORS)).toEqual([]);
  });
});

describe("holdingRowKeys", () => {
  it("'CUSIP:클래스' — 같은 키가 또 나오면 '#2'·'#3' 꼬리, 줄 차례 그대로", () => {
    expect(
      holdingRowKeys([
        { cusip: "037833100", class: "COM" },
        { cusip: "02079K305", class: "CAP STK CL A" },
        { cusip: "037833100", class: "COM" },
        { cusip: "037833100", class: "COM" },
      ]),
    ).toEqual(["037833100:COM", "02079K305:CAP STK CL A", "037833100:COM#2", "037833100:COM#3"]);
  });

  it("같은 CUSIP이라도 클래스가 다르면 다른 키", () => {
    expect(holdingRowKeys([{ cusip: "000000001", class: "COM" }, { cusip: "000000001", class: "PFD" }])).toEqual(["000000001:COM", "000000001:PFD"]);
  });

  it("줄이 없으면 빈 목록", () => {
    expect(holdingRowKeys([])).toEqual([]);
  });
});

describe("institutionTitle", () => {
  const items = [{ key: "0001067983", label: "가상 버크셔", desc: "" }];

  it("목록 이름 → 포트폴리오 응답의 기관 이름(국기 뗌) → 'CIK …'", () => {
    expect(institutionTitle(items, "0001067983", { institution: { name: "응답 이름" } })).toBe("가상 버크셔");
    expect(institutionTitle([], "0001067983", { institution: { name: "\u{1F1FA}\u{1F1F8} 응답 이름" } })).toBe("응답 이름");
    expect(institutionTitle([], "0001067983", null)).toBe("CIK 0001067983");
    expect(institutionTitle(items, "0001608046", { institution: {} })).toBe("CIK 0001608046");
  });
});

describe("portfolioKpis", () => {
  const krw = { toKrw: (usd: number | null | undefined) => (usd == null ? null : `약 ${usd * 2}원`), note: "원/달러 2.00 기준" };
  const data: Pick<PortfolioResponse, "latest" | "quarters"> = {
    latest: { reportDate: "2026-06-30", filingDate: "2026-08-14", totalValue: 1_000_000 },
    quarters: [
      { filingDate: "2026-05-15", reportDate: "2026-03-31", totalValue: 900_000, holdingCount: 10 },
      { filingDate: "2026-08-14", reportDate: "2026-06-30", totalValue: 1_000_000, holdingCount: 11 },
    ],
  };

  it("기준일(보조 제출일·출처) · 총액(값 = 조·억 숫자, 단위 '달러' — formatCurrency와 같은 글자, 보조 원화 + 환율 글) · 분기 수(단위 '개'·보조 기준일 목록)", () => {
    const [date, total, quarters] = portfolioKpis(data, krw, "합성 출처");
    expect(date).toMatchObject({ key: "reportDate", label: "최신 공시 기준일", value: "2026-06-30", note: "제출일 2026-08-14", source: "합성 출처" });
    expect(total).toMatchObject({ key: "totalValue", label: "포트폴리오 총액", value: 1_000_000, note: "약 2000000원 · 원/달러 2.00 기준" });
    expect(total.unit).toBe("달러");
    expect(`${total.format?.(1_000_000)} ${total.unit}`).toBe(formatCurrency(1_000_000));
    expect(total.format?.(299_300_000_000)).toBe("2,993억");
    expect(total.source).toBeUndefined();
    expect(quarters).toMatchObject({ key: "quarters", label: "수집된 분기", value: 2, unit: "개", note: "2026-03-31, 2026-06-30" });
    expect(quarters.format?.(2)).toBe("2");
    expect(quarters.source).toBeUndefined();
  });

  it("모르는 값은 null(0으로 채우지 않음) — 총액을 모르면 원화 없이 환율 글만, 제출일을 모르면 '제출일 —'", () => {
    const [date, total] = portfolioKpis(
      { latest: { reportDate: "", filingDate: "", totalValue: null }, quarters: [] },
      { toKrw: () => null, note: "원/달러 값이 없어 원화 환산은 생략했습니다." },
      "합성 출처",
    );
    expect(date.value).toBeNull();
    expect(date.note).toBe("제출일 —");
    expect(total.value).toBeNull();
    expect(total.note).toBe("원/달러 값이 없어 원화 환산은 생략했습니다.");
  });

  it("분기가 없으면 0개(센 수)·보조 없음, 응답이 없으면 빈 목록", () => {
    const kpis = portfolioKpis({ latest: undefined, quarters: [] }, krw, "합성 출처");
    expect(kpis[2]).toMatchObject({ value: 0, note: null });
    expect(kpis[1].value).toBeNull();
    expect(portfolioKpis(null, krw, "합성 출처")).toEqual([]);
  });
});

function holding(overrides: Partial<Holding>): Holding {
  return { name: "SYNTHETIC CO", cusip: "000000001", class: "COM", value: 100, shares: 10, weight: 10, weightDiff: null, sharesDiff: null, action: "유지 (Unchanged)", ...overrides };
}

describe("holdingRowLabels", () => {
  it("겹치지 않는 이름은 그대로, 겹치는 이름에만 클래스(기관 상세와 같은 규칙) — 키는 줄 키", () => {
    const labels = holdingRowLabels([
      holding({ name: "APPLE INC", cusip: "037833100", class: "COM" }),
      holding({ name: "ALPHABET INC", cusip: "02079K305", class: "CAP STK CL A" }),
      holding({ name: "ALPHABET INC", cusip: "02079K107", class: "CAP STK CL C" }),
    ]);
    expect([...labels]).toEqual([
      ["037833100:COM", "APPLE INC"],
      ["02079K305:CAP STK CL A", "ALPHABET INC · CAP STK CL A"],
      ["02079K107:CAP STK CL C", "ALPHABET INC · CAP STK CL C"],
    ]);
  });

  it("'CUSIP:클래스'까지 같은 줄은 키의 '#n' 꼬리를 이름표에도 — 서로 다른 이름표", () => {
    const labels = holdingRowLabels([holding({ name: "SAME CO" }), holding({ name: "SAME CO" })]);
    expect(labels.size).toBe(2);
    expect(new Set(labels.values()).size).toBe(2);
    expect(labels.get("000000001:COM#2")).toMatch(/ #2$/);
  });
});

describe("holdingInspectorItems", () => {
  const krw = { toKrw: (usd: number | null | undefined) => (usd == null ? null : `약 ${usd * 2}원`), note: "원/달러 2.00 기준" };

  it("기관 상세 보유 검사 칸과 같은 줄 + 평가액 다음에 '원화 환산'(보조 = 환율 글)", () => {
    const items = holdingInspectorItems(holding({ value: 500, shares: 1234, sharesDiff: -34, weightDiff: -0.25, action: "비중 축소 (Reduced)" }), krw);
    expect(items.map((item) => item.label)).toEqual(["공시 이름", "클래스", "CUSIP", "비중", "평가액", "원화 환산", "주식 수", "주식 수 변화", "비중 변화", "동작"]);
    expect(items[5]).toMatchObject({ value: "약 1000원", note: "원/달러 2.00 기준" });
    expect(items[6].value).toBe("1,234주");
    expect(items[7].value).toBe("\u221234주");
    expect(items[8].value).toBe("\u22120.25%p");
  });

  it("환율·평가액을 모르면 원화 환산은 null('—') — 보조 글은 그대로", () => {
    const items = holdingInspectorItems(holding({}), { toKrw: () => null, note: "원/달러 값이 없어 원화 환산은 생략했습니다." });
    const krwItem = items.find((item) => item.label === "원화 환산");
    expect(krwItem).toMatchObject({ value: null, note: "원/달러 값이 없어 원화 환산은 생략했습니다." });
  });
});
