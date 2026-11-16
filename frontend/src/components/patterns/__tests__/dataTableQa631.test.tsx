/**
 * QA-631: 공용 표(DataTable)의 가로 스크롤 상자가 위치 기준(containing block)이 아니라, 칸 안의 절대 위치 요소(변화 칩의 낭독용 '상승/하락' 글 —
 * sr-only)가 상자에 잘리지 않고 화면 본문(main)의 넘침이 되었습니다.
 *
 * 넓은 화면(lg 이상)의 본문은 overflow-x hidden이라 스크롤 막대는 없지만 코드로는 옆으로 밀립니다. 낭독기 훑기·찾기처럼 그 글을 보이게 하려는 동작
 * (scrollIntoView)이 상자 대신 본문을 밀어, 화면 전체가 왼쪽으로 142px 밀린 채 되돌릴 수단이 없었습니다(P5a 가벼운 갈래 브라우저 확인 — /sector 1024,
 * 메뉴 220: 본문 scrollWidth 946 · clientWidth 804, 가장 먼 칩 글로 scrollIntoView → main.scrollLeft 0 → 142, 표 상자는 0 그대로). 좁은 화면은 본문이
 * overflow-x clip이라 밀리지 않지만 같은 넘침이 있었습니다(홈 390 본문 scrollWidth 494).
 *
 * jsdom은 배치를 재지 않으므로 상자가 위치 기준(position: relative — Tailwind `relative`)인지를 봅니다(QA-501과 같은 방식). 위치 기준이면 절대 위치
 * 자식이 상자의 스크롤 넘침에 들어가 상자 안에서 잘리고, 보이게 하려면 상자가 스크롤됩니다. 고치기 전 값: 상자 클래스에 relative 없음
 * (w-full min-w-0 max-w-full overflow-x-auto rounded-sm …).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChangeChip } from "../ChangeChip";
import { type Column, DataTable } from "../DataTable";

afterEach(() => cleanup());

type Row = { key: string; change: number };

const COLUMNS: Column<Row>[] = [
  { key: "key", header: "이름", cell: (row) => row.key },
  { key: "change", header: "변화", align: "right", cell: (row) => <ChangeChip size="sm" nowrap changePct={row.change} /> },
];

describe("QA-631 가로 스크롤 상자가 칸 안 절대 위치 글의 위치 기준이다", () => {
  it.fails.each([
    ["넘김 안내 없는 표", false],
    ["넘김 안내를 둔 넓은 표", "overflow"],
  ] as const)("%s의 스크롤 상자는 relative(위치 기준)다", (_, scrollHint) => {
    render(<DataTable caption="변화 표" columns={COLUMNS} rows={[{ key: "a", change: -1.2 }]} rowKey={(row) => row.key} scrollHint={scrollHint} />);

    const box = screen.getByRole("region", { name: "변화 표 (좌우 스크롤)" });
    expect(box.className.split(/\s+/)).toContain("relative");
    // 칩의 낭독용 글은 절대 위치(sr-only) — 이 상자 안에 있습니다.
    expect(box.querySelector(".sr-only")).toBeTruthy();
  });
});
