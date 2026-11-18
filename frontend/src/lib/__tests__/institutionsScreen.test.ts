/**
 * 13F 포트폴리오 화면 모델(lib/institutionsScreen) — 기관 목록 줄·비중 추이 선·보유 표 줄 키.
 */
import { describe, expect, it } from "vitest";

import { holdingRowKeys, institutionItems, WEIGHT_LINE_LABEL_WIDTH, weightLines } from "../institutionsScreen";

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
