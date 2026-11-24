/**
 * QA-995 — 응답 전 자리가 응답 뒤보다 작아 응답이 오면 아래 내용이 밀리던 화면(성능 개선 2차 작업 E, 사용자 결정 D-5 — 내용·순서·숫자는 그대로, 응답 전 자리의 높이만).
 * 화면 밀림(CLS) 자체는 QA 스택에서 scripts/qa/page-apis.js·lighthouse.sh로 재고(docs/qa/evidence/2026-11-24-perf/step3-band-layout.txt), 여기서는 그 자리를
 * 만드는 순수 함수의 꼴을 고정합니다.
 *  - 보안 공지 판정·사유 칩: 건수가 응답 뒤에 붙어 칩이 넓어지며 줄바꿈이 바뀌어 칩들이 옮겨 갔음 → 건수 자리의 견본(세 자리 건수 폭)을 응답 전에도 둠
 *  - 보안 공지 판정 요약의 버전 목록 타일: 응답 뒤 보조 줄(버전 목록 나이)이 생겨 띠가 64px → 90px → 읽는 중에도 한 줄 자리
 */
import { describe, expect, it } from "vitest";

import { reasonFilterItems, securityKpis, verdictFilterItems } from "../security";

describe("QA-995: 응답 전 자리가 응답 뒤 꼴을 미리 잡는다", () => {
  it.fails("보안 공지 판정·사유 칩은 건수를 받기 전에도 세 자리 건수 폭의 자리를 둔다(사유 '전체'는 건수가 없어 자리도 없음)", () => {
    const verdicts = verdictFilterItems(null) as Array<{ noteSlot?: string }>;
    expect(verdicts.every((item) => item.noteSlot === "000건")).toBe(true);
    const reasons = reasonFilterItems(null) as Array<{ key: string; noteSlot?: string }>;
    expect(reasons.slice(1).every((item) => item.noteSlot === "000건")).toBe(true);
    expect(reasons[0].noteSlot).toBeUndefined();
  });

  it.fails("보안 공지 판정 요약은 읽는 중에도 버전 목록 타일에 보조 줄 하나의 자리를 둔다", () => {
    const pending = securityKpis(null, true);
    expect(pending.find((item) => item.key === "inventory")?.pendingLines).toBe(1);
    expect(pending.filter((item) => item.key !== "inventory").every((item) => item.pendingLines === undefined)).toBe(true);
    expect(securityKpis(null, false).every((item) => item.pendingLines === undefined)).toBe(true);
  });
});
