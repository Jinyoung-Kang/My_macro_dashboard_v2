/**
 * 상세 화면의 뉴스·AI 요약 검색어 줄이기(QA-448) — 백엔드 DetailService.query는 앞뒤 공백을 뺀 Java 길이(UTF-16 단위)가 60을 넘으면 400이라,
 * 결과는 늘 `.length <= 60`이고 글자(코드 포인트)를 가르지 않아야 합니다. 이름은 모두 합성 값입니다.
 */
import { describe, expect, it } from "vitest";
import { DETAIL_QUERY_MAX, detailQuery, SYMBOL_QUERY_MAX, symbolQuery } from "@/lib/detail";

/** 짝 없는 서로게이트(코드 포인트를 가른 흔적)가 있는가. */
const loneSurrogate = (text: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

describe("detailQuery — 상세 화면의 뉴스·AI 요약 검색어(QA-448)", () => {
  it("상한은 백엔드와 같은 60", () => {
    expect(DETAIL_QUERY_MAX).toBe(60);
  });

  it("비었거나 공백뿐이면 null", () => {
    expect(detailQuery(null)).toBeNull();
    expect(detailQuery(undefined)).toBeNull();
    expect(detailQuery("")).toBeNull();
    expect(detailQuery("   \n\t ")).toBeNull();
  });

  it("상한 안이면 공백만 정리한 그대로 — 마침표·쉼표도 그대로", () => {
    expect(detailQuery("Apple Inc.")).toBe("Apple Inc.");
    expect(detailQuery("  Synthetic   Example\nHoldings, Inc.  ")).toBe("Synthetic Example Holdings, Inc.");
  });

  it("정확히 60자는 자르지 않고, 61자부터 줄인다", () => {
    const sixty = `${"Synthetic ".repeat(5)}Exampleabc`;
    expect(sixty).toHaveLength(60);
    expect(detailQuery(sixty)).toBe(sixty);
    expect(detailQuery(`  ${sixty}  `)).toBe(sixty);
    const result = detailQuery(`${sixty}d`);
    expect(result).toBe("Synthetic Synthetic Synthetic Synthetic Synthetic");
  });

  it("낱말 가운데서 넘으면 앞 낱말 끝까지 — QA 스택에서 쓴 71자 모의 이름", () => {
    const name = "Fictional Universal Financial Holdings Group Incorporated International";
    expect(name).toHaveLength(71);
    expect(detailQuery(name)).toBe("Fictional Universal Financial Holdings Group Incorporated");
  });

  it("상한이 낱말 끝에 걸리면 그 낱말까지 담는다", () => {
    const head = `${"Abcdefghi ".repeat(5)}Abcdefghij`; // 60자, 61번째가 공백
    expect(head).toHaveLength(60);
    expect(detailQuery(`${head} Extra`)).toBe(head);
  });

  it("상한이 낱말 끝에 걸리고 다음 글자가 문장 부호면 그 낱말까지 담는다 — 낱말 가운데로 보지 않음(검토 지적)", () => {
    const base = "Synthetic Example Financial Group Holdings Worldwide"; // 52자
    expect(`${base} Partner`).toHaveLength(60);
    expect(detailQuery(`${base} Partner, Inc.`)).toBe(`${base} Partner`);
    expect(detailQuery(`${base} Partner) Limited`)).toBe(`${base} Partner`);
    expect(detailQuery(`${base} Partner-Owned Fund`)).toBe(`${base} Partner`);
    // 다음 글자가 글자·숫자·결합 부호면 낱말 가운데 — 앞 낱말 끝까지.
    expect(detailQuery(`${base} Partners Inc.`)).toBe(base);
    expect(detailQuery(`${base} Partner2 Inc.`)).toBe(base);
    expect(detailQuery(`${base} Partner\u0301 Inc.`)).toBe(base); // 마지막 r에 붙는 결합 부호 — 글자를 가르지 않게
  });

  it("끝에 남은 쉼표·이음 기호와 잘려서 닫히지 않은 괄호는 뗀다 — 마침표(약칭)와 닫힌 괄호는 둠", () => {
    const base = "Synthetic Example Financial Group Holdings Worldwide"; // 52자
    expect(base).toHaveLength(52);
    expect(detailQuery(`${base}, International Branch`)).toBe(base);
    expect(detailQuery(`${base} & Coalition Partners`)).toBe(base);
    expect(detailQuery(`${base} - Example Series`)).toBe(base);
    expect(detailQuery(`${base} (Cayman Islands) Limited`)).toBe(base);
    expect(detailQuery(`${base}, Inc. International Branch`)).toBe(`${base}, Inc.`);
    expect(detailQuery(`Synthetic (US) Example Financial Group Holdings Worldwide Partners`)).toBe("Synthetic (US) Example Financial Group Holdings Worldwide");
    // 앞 절반에서 열린 괄호는 이름의 본체라 두고 낱말 경계로만 자름(검색어로는 괄호가 남아도 됨 — 백엔드는 받음).
    expect(detailQuery(`Synthetic (Example Financial Group Holdings Worldwide Partners Limited)`)).toBe("Synthetic (Example Financial Group Holdings Worldwide");
  });

  it("띄어 쓰지 않은 긴 이름(앞 절반 안에 공백뿐)은 상한에서 그대로 자른다", () => {
    const korean = "가상".repeat(40); // 80자, 공백 없음
    expect(detailQuery(korean)).toBe("가상".repeat(30));
    const early = `A ${"B".repeat(70)}`;
    expect(detailQuery(early)).toBe(`A ${"B".repeat(58)}`);
  });

  it("글자(코드 포인트)를 가르지 않고, 백엔드가 세는 UTF-16 길이로 60 안", () => {
    const wide = "\u{1D538}"; // 수학 기호 A — UTF-16 두 단위, 한 글자
    const allWide = wide.repeat(40); // 40글자 = 80 단위
    const clamped = detailQuery(allWide)!;
    expect(clamped).toBe(wide.repeat(30));
    expect(clamped.length).toBeLessThanOrEqual(DETAIL_QUERY_MAX);

    // 홀수 자리에서 넘는 경우 — 'a' + 두 단위 글자들: 60단위째에서 글자가 갈리면 그 글자를 담지 않음(59단위).
    const odd = detailQuery(`a${allWide}`)!;
    expect(odd).toBe(`a${wide.repeat(29)}`);
    expect(odd.length).toBe(59);
    expect(loneSurrogate(odd)).toBe(false);

    // 글자 수로는 60이어도 UTF-16 길이가 넘으면 줄임 — 백엔드는 400을 주므로.
    const sixtyChars = `${"x".repeat(59)}${wide}`;
    expect(Array.from(sixtyChars)).toHaveLength(60);
    expect(detailQuery(sixtyChars)).toBe("x".repeat(59));
  });
});

describe("symbolQuery — 13F 종목 팝업의 종목 찾기 검색어(공시 이름, 상한 40)", () => {
  it("상한은 백엔드 MAX_SYMBOL_QUERY·수집기 /live/symbols와 같은 40", () => {
    expect(SYMBOL_QUERY_MAX).toBe(40);
  });

  it("40자 안이면 공백만 정리한 그대로, 비면 null", () => {
    expect(symbolQuery("ISHARES TR")).toBe("ISHARES TR");
    expect(symbolQuery("  BERKSHIRE   HATHAWAY INC DEL ")).toBe("BERKSHIRE HATHAWAY INC DEL");
    expect(symbolQuery("   ")).toBeNull();
    expect(symbolQuery(null)).toBeNull();
  });

  it("40자를 넘으면 낱말 경계에서 자르고 끝 이음 기호를 뗀다 — 결과는 늘 40자 이하", () => {
    const forty = `${"SYNTHETIC ".repeat(3)}EXAMPLE CO`;
    expect(forty).toHaveLength(40);
    expect(symbolQuery(forty)).toBe(forty);
    expect(symbolQuery("FICTIONAL UNIVERSAL INTERNATIONAL HOLDINGS GROUP INC")).toBe("FICTIONAL UNIVERSAL INTERNATIONAL");
    expect(symbolQuery("FICTIONAL UNIVERSAL INTERNATIONAL CO & HOLDINGS")).toBe("FICTIONAL UNIVERSAL INTERNATIONAL CO");
    for (const name of ["SPDR S&P MIDCAP 400 ETF TRUST SERIES ONE UNIT", `${"X".repeat(45)} CO`, "A ".repeat(30)]) {
      expect((symbolQuery(name) ?? "").length).toBeLessThanOrEqual(SYMBOL_QUERY_MAX);
    }
  });
});
