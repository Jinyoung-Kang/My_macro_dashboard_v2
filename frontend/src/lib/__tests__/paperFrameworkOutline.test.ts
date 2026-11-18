/**
 * 모의매매 프레임 탭의 순수 규칙(lib/paperFrameworkOutline — 작업대 P6): 렌더링 글을 머리 줄마다 절로(글은 그대로), 목차 하위 칸 단계, 판 이력 줄.
 */
import { describe, expect, it } from "vitest";

import {
  frameworkOutline,
  frameworkOutlineText,
  frameworkOutlineTocLevel,
  frameworkVersionEntries,
} from "../paperFrameworkOutline";

/** QA 스택 v1과 같은 꼴 — 제목(#) 하나, 절(##) 여럿, 엔진 머리(###). */
const RENDERED = [
  "# 투자 OS — v1 (합성 판)",
  "",
  "## 원칙",
  "1. 패킷의 숫자에서 출발한다.",
  "## 엔진",
  "### E1. 시장관",
  "- E1-R1 세 축으로 노출을 정한다.",
  "### E2. 인과관계",
  "- E2-R1 #해시 글은 머리가 아니다.",
  "#### 네 단계는 글 줄",
  "## 출력(고정)",
  "```json",
  "# 울타리 안은 머리가 아님",
  "```",
  "끝 줄",
].join("\n");

describe("frameworkOutline", () => {
  it("#·##·###마다 절 — 단계·제목·줄, 이으면 원래 글 그대로", () => {
    const sections = frameworkOutline(RENDERED);
    expect(sections.map((section) => [section.id, section.level, section.title])).toEqual([
      ["paper-frame-section-0", 1, "투자 OS — v1 (합성 판)"],
      ["paper-frame-section-1", 2, "원칙"],
      ["paper-frame-section-2", 2, "엔진"],
      ["paper-frame-section-3", 3, "E1. 시장관"],
      ["paper-frame-section-4", 3, "E2. 인과관계"],
      ["paper-frame-section-5", 2, "출력(고정)"],
    ]);
    expect(sections[4].lines).toEqual(["- E2-R1 #해시 글은 머리가 아니다.", "#### 네 단계는 글 줄"]);
    expect(sections[5].lines).toEqual(["```json", "# 울타리 안은 머리가 아님", "```", "끝 줄"]);
    expect(frameworkOutlineText(sections)).toBe(RENDERED);
  });

  it("머리 앞의 글은 머리 없는 절(단계 0) 하나, 머리가 없으면 글 전체가 한 절", () => {
    const sections = frameworkOutline("앞글 한 줄\n\n## 원칙\n본문", "frame");
    expect(sections.map((section) => [section.id, section.level, section.title, section.heading])).toEqual([
      ["frame-0", 0, null, null],
      ["frame-1", 2, "원칙", "## 원칙"],
    ]);
    expect(sections[0].lines).toEqual(["앞글 한 줄", ""]);
    expect(frameworkOutlineText(sections)).toBe("앞글 한 줄\n\n## 원칙\n본문");

    const plain = frameworkOutline("머리 없는 글\n둘째 줄");
    expect(plain).toHaveLength(1);
    expect(plain[0]).toMatchObject({ level: 0, title: null, lines: ["머리 없는 글", "둘째 줄"] });
  });

  it("글이 없으면 빈 목록, '#' 뒤에 빈칸이 없거나 글이 없으면 머리가 아님", () => {
    expect(frameworkOutline(null)).toEqual([]);
    expect(frameworkOutline("")).toEqual([]);
    expect(frameworkOutline("#붙은 글\n#   \n## 머리").map((section) => section.level)).toEqual([0, 2]);
  });
});

describe("frameworkOutlineTocLevel", () => {
  it("두 번 이상 나오는 가장 높은 단계 — 제목 하나(#)와 절 여럿(##)이면 ##", () => {
    expect(frameworkOutlineTocLevel(frameworkOutline(RENDERED))).toBe(2);
    expect(frameworkOutlineTocLevel(frameworkOutline("# 하나\n# 둘\n## 셋"))).toBe(1);
  });

  it("두 번 나오는 단계가 없으면 있는 가장 높은 단계, 머리가 없으면 null", () => {
    expect(frameworkOutlineTocLevel(frameworkOutline("# 제목\n## 절\n### 소절"))).toBe(1);
    expect(frameworkOutlineTocLevel(frameworkOutline("머리 없음"))).toBeNull();
    expect(frameworkOutlineTocLevel([])).toBeNull();
  });
});

describe("frameworkVersionEntries", () => {
  it("판 목록(최근 순) → 종류·출처·만든 시각·토큰·지금 판, 모르는 값은 '—'·null", () => {
    const entries = frameworkVersionEntries(
      [
        { version: 2, title: "제안 반영", changelog: "규칙 하나 더함", createdAtKst: "2026-11-01 09:00 KST", sourceProposalId: 3, status: "USER", tokensEst: 3600 },
        { version: 1, title: "투자 OS", changelog: null, createdAtKst: "2026-10-25 02:37 KST", sourceProposalId: null },
        { version: 0, title: null, changelog: "임시", createdAtKst: null, sourceProposalId: null, status: "INTERIM" },
      ],
      2,
    );
    expect(entries.map((entry) => [entry.label, entry.kind, entry.source, entry.createdAt, entry.createdDate, entry.tokens, entry.current])).toEqual([
      ["v2", "제안 승인", "제안 #3 승인", "2026-11-01 09:00", "2026-11-01", "추정 3,600토큰", true],
      ["v1", "수동 편집", "수동 편집", "2026-10-25 02:37", "2026-10-25", null, false],
      ["임시 v0", "처음", "처음 시드(임시)", "—", null, null, false],
    ]);
    expect(entries[1].changelog).toBe("—");
    expect(entries[2].title).toBe("—");
  });

  it("번호가 없는 줄은 빼고, 목록이 없으면 빈 목록", () => {
    expect(frameworkVersionEntries(null, null)).toEqual([]);
    expect(
      frameworkVersionEntries([{ version: Number.NaN, title: "x", changelog: null, createdAtKst: null, sourceProposalId: null }], null),
    ).toEqual([]);
  });
});
