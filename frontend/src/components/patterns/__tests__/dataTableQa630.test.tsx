/**
 * QA-630: 공용 표(DataTable)의 고른 행이 바뀌면 첫 칸 안의 단추가 새로 만들어져 키보드 포커스를 잃었습니다.
 *
 * 고른 행의 첫 칸만 내용 앞에 막대(SELECTED_BAR)를 붙이는데, 막대가 있을 때(조각 — 막대 + 내용)와 없을 때(내용 하나)의 React 구조가 달라
 * 고름이 그 행으로 오거나 떠날 때 첫 칸의 내용(행 머리의 고르기 단추·검사 칸 틀의 줄 단추)이 다시 그려졌습니다. 그래서 첫 칸 단추를 Enter로 눌러
 * 그 행을 고르면 포커스가 문서 바탕(body)으로 빠졌습니다(P5a 가벼운 갈래 브라우저 확인 — /cot '자산별 요약'의 자산 단추, 390·1024·1440 모두).
 * 매크로 지표 표처럼 검사 칸 틀(옆 칸 배치)의 줄 단추를 첫 칸에 두는 표도 같은 길을 탑니다. 고치기 전 값: 고른 뒤 document.activeElement가 BODY,
 * 누른 단추는 문서에서 떨어져 나감(isConnected false).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { type Column, DataTable } from "../DataTable";

afterEach(() => cleanup());

type Row = { key: string; name: string; value: number };

const ROWS: Row[] = [
  { key: "a", name: "가", value: 1 },
  { key: "b", name: "나", value: 2 },
];

function PickTable() {
  const [picked, setPicked] = useState("a");
  const columns: Column<Row>[] = [
    {
      key: "name",
      header: "이름",
      rowHeader: true,
      cell: (row) => (
        <button type="button" onClick={() => setPicked(row.key)}>
          {row.name}
        </button>
      ),
    },
    { key: "value", header: "값", align: "right", cell: (row) => row.value },
  ];
  return <DataTable caption="고르기 표" columns={columns} rows={ROWS} rowKey={(row) => row.key} selectedKey={picked} />;
}

describe("QA-630 고른 행이 바뀌어도 첫 칸 단추의 포커스가 남는다", () => {
  it("첫 칸 단추로 그 행을 고르면 그 단추에 포커스가 남고, 앞에 고른 행의 단추도 같은 요소다", () => {
    render(<PickTable />);
    const first = screen.getByRole("button", { name: "가" });
    const second = screen.getByRole("button", { name: "나" });

    second.focus();
    fireEvent.click(second);

    expect(screen.getByRole("button", { name: "나" }).closest("tr")?.getAttribute("aria-current")).toBe("true");
    expect(document.activeElement?.tagName).toBe("BUTTON");
    expect(second.isConnected).toBe(true);
    expect(document.activeElement).toBe(second);
    // 고름이 떠난 행의 단추도 다시 만들어지지 않음.
    expect(screen.getByRole("button", { name: "가" })).toBe(first);
  });
});
