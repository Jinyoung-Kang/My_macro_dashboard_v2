/**
 * 정보 검색 출처 상태 줄이 그 출처가 준 것을 말하는지(QA-437 — 계약 §3-4 SourceStatus·§5 출처 상태 줄). 응답은 모두 합성 값입니다.
 *
 * 같은 글(계약 §4 규칙 4)은 우선순위가 앞선 출처 하나로 남고 건수도 그쪽에 셉니다(상태 줄 건수의 합 = 줄 수). 수집기는 같은 글이라 다른 줄과 합친
 * 수를 `dropped.duplicate`로 주고, 화면은 그 수를 상태 줄에 적어 '0건'이 '받은 것이 없음'으로 읽히지 않게 합니다.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { droppedText, sourceStatusView } from "@/lib/infoSearch";
import type { SearchSourceStatus } from "@/lib/types";
import { SourceStatusLine } from "../parts";

afterEach(() => cleanup());

/** 상태 줄 하나 — dropped는 변수로 받아 넘깁니다(duplicate가 없는 옛 응답 모양도 같은 길로). */
function statusRow(over: Partial<SearchSourceStatus>, dropped: Record<string, number>): SearchSourceStatus {
  const row = { source: "finviz", label: "Finviz 종목 뉴스", status: "ok", count: 0, message: null, ...over, dropped };
  return row as SearchSourceStatus;
}

const NONE = { old: 0, noTime: 0, chinese: 0, excluded: 0 };

describe("QA-437 출처 상태 줄 — 같은 글이라 다른 줄과 합친 건수", () => {
  // QA-437: 관심 대상 수집이 같은 기사를 이미 모아 두면 뒤의 출처(Finviz·Bing·구글)는 줄을 줬어도 '0건'이고 막 받은 결과면 '결과 없음'이었음.
  // 수집기가 합친 수(dropped.duplicate)를 주고 상태를 ok로 고친 뒤, 화면은 그 수를 '0건' 곁에 적습니다.
  // 수정 전 실패: droppedText가 duplicate를 몰라 null — 상태 줄이 'Finviz 종목 뉴스 · 받음 · 0건'만(재현 커밋에서는 it.fails).
  it("받은 줄이 모두 다른 줄과 같은 글이면 '0건'과 함께 합친 건수를 적는다", () => {
    const row = statusRow({}, { ...NONE, duplicate: 49 });
    expect(sourceStatusView(row)).toMatchObject({ status: "받음", count: "0건", dropped: "같은 글이라 다른 줄과 합침 49건" });
    render(<SourceStatusLine sources={[statusRow({ status: "cached" }, { ...NONE, duplicate: 49 })]} />);
    const line = screen.getByRole("list", { name: "출처 상태" }).textContent ?? "";
    expect(line).toContain("캐시");
    expect(line).toContain("0건");
    expect(line).toContain("같은 글이라 다른 줄과 합침 49건");
  });

  // 수정 전 실패: 합친 건수 없이 '뺀 줄: 2년 밖 3건'만(재현 커밋에서는 it.fails).
  it("뺀 줄이 함께 있으면 합친 건수를 먼저, 뺀 줄 목록과 섞지 않는다", () => {
    expect(droppedText(statusRow({}, { ...NONE, old: 3, chinese: 1, duplicate: 2 }).dropped))
      .toBe("같은 글이라 다른 줄과 합침 2건 · 뺀 줄: 2년 밖 3건 · 중국어 제목 1건");
  });

  it("합친 줄이 0이거나 칸이 없으면(백엔드가 지운 운영자 전용 줄·옛 응답) 지금 글 그대로", () => {
    expect(droppedText(statusRow({}, { ...NONE, duplicate: 0 }).dropped)).toBeNull();
    expect(droppedText(statusRow({}, { ...NONE, excluded: 4 }).dropped)).toBe("뺀 줄: 제외 매체 4건");
    expect(droppedText(statusRow({}, { ...NONE, excluded: 4, duplicate: 0 }).dropped)).toBe("뺀 줄: 제외 매체 4건");
  });
});
