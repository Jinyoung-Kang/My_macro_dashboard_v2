/**
 * QA-526: 옛 공용 표(ui Table)의 머리·칸이 좁은 칸에서 한글 낱말 중간에 줄을 바꿨습니다 — 브라우저 기본 줄바꿈(word-break: normal)은 한글을 글자마다
 * 끊을 수 있는 자리로 보아 '기준일'이 '기준/일', '승률'이 '승/률'처럼 갈렸습니다(D1 QA 스택 확인 'old-ui-table-midword-wrap' — 개편 전부터, 국면 판정 성과 1024·390,
 * COT 자산별 요약 기준일 390).
 *
 * 고친 뒤: 머리(th)·칸(td)이 모두 낱말 사이에서만 줄을 바꿉니다(break-keep — word-break: keep-all). 낱말 안 꺾기(wrap-anywhere·break-all)는 넣지 않습니다 —
 * 칸의 최소 내용 폭을 한 글자로 줄여 같은 꺾임을 다시 냅니다. 표는 최소 640px 가로 스크롤 상자 안이라 칸이 넓어지면 상자 안에서 넘깁니다.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Table } from "../index";

afterEach(() => cleanup());

type Row = { name: string; date: string; rate: string };

const ROWS: Row[] = [
  { name: "확장 국면", date: "2026-11-10", rate: "62.5%" },
  { name: "둔화 국면", date: "2026-11-09", rate: "48.0%" },
];

describe("QA-526 옛 공용 표 — 낱말 사이에서만 줄바꿈", () => {
  it.fails("머리(th)·칸(td) 모두 break-keep이고 낱말 안 꺾기(wrap-anywhere·break-all)는 없다", () => {
    const { container } = render(
      <Table<Row>
        label="국면 판정 성과"
        rows={ROWS}
        rowKey={(row) => row.name}
        columns={[
          { key: "name", header: "판정 국면", render: (row) => row.name },
          { key: "date", header: "기준일", render: (row) => row.date },
          { key: "rate", header: "적중률", align: "right", render: (row) => row.rate },
        ]}
      />,
    );
    const cells = [...container.querySelectorAll("th, td")];
    expect(cells).toHaveLength(9);
    const missing = cells
      .filter((cell) => {
        const tokens = cell.className.split(/\s+/);
        return !tokens.includes("break-keep") || tokens.includes("wrap-anywhere") || tokens.includes("break-all");
      })
      .map((cell) => `${cell.tagName.toLowerCase()} ${cell.textContent}`);
    expect(missing).toEqual([]);
  });
});
