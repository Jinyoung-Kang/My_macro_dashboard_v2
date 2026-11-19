/**
 * AI 리포트 본문 표의 넘김 안내·표 이름 — QA-869(작업대 P7 검토에서 찾음).
 *
 * 리포트 Markdown 표(ReportView의 ReportTable)는 최소 520px 표를 손으로 만든 overflow-x-auto 상자에 넣고 넘김 안내가 없어, 390에서 칸 대부분이 단서 없이
 * 상자 밖으로 숨었습니다(본문 폭 약 308px — 명세 '넘치면 늘 안내'). <caption>도 없고 리포트 안의 모든 표가 같은 영역 이름 '리포트 표 (좌우 스크롤)'이었습니다.
 * moreTablesScrollHint는 `<DataTable` 여는 태그만 훑어 이 표를 놓쳤습니다.
 *
 * 기대: 공용 조밀 표(DataTable — 넘김 안내 scrollHint="overflow"·표 이름)로 그려, 표마다 '{절 제목} 표'(한 절에 둘 이상이면 '표 n') 이름의 영역·caption과
 * 넘김 안내 줄이 있습니다.
 * 수정 전(재현 커밋에서는 it.fails): 첫 사례 'Unable to find an accessible element with the role "region" and name "2. 수급 표 1 (좌우 스크롤)"'(영역
 * 이름이 모두 '리포트 표 (좌우 스크롤)'), 둘째 사례 'Unable to find an element with the text: ← 표를 좌우로 넘겨 보세요', moreTablesScrollHint 새 사례
 * "expected [ 'ai/report/ReportView.tsx' ] to deeply equal []".
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReportView } from "../ai/report/ReportView";

afterEach(() => cleanup());

const REPORT = `## 1. 핵심 요약
합성 요약 문단입니다.

## 2. 수급
| 항목 | 값 |
|---|---|
| 외국인 순매수 | 1,339.98 |

| 항목 | 값 |
|---|---|
| 기관 순매수 | -12.5 |

## 3. 금리
| 항목 | 값 |
|---|---|
| 미국 10년 | 4.1 |
`;

describe("AI 리포트 본문 표 — 넘김 안내·표 이름(QA-869)", () => {
  it.fails("표마다 '{절 제목} 표'(한 절에 둘 이상이면 '표 n') 이름의 영역과 caption", () => {
    render(<ReportView markdown={REPORT} />);
    const names = ["2. 수급 표 1", "2. 수급 표 2", "3. 금리 표"];
    for (const name of names) {
      const region = screen.getByRole("region", { name: `${name} (좌우 스크롤)` });
      expect(within(region).getByRole("table").querySelector("caption")?.textContent).toBe(name);
    }
    expect(screen.queryByRole("region", { name: "리포트 표 (좌우 스크롤)" })).toBeNull();
  });

  it.fails("표마다 넘김 안내 줄('← 표를 좌우로 넘겨 보세요')이 표 앞에 있다", () => {
    render(<ReportView markdown={REPORT} />);
    const hints = screen.getAllByText("← 표를 좌우로 넘겨 보세요");
    expect(hints).toHaveLength(3);
    const region = screen.getByRole("region", { name: "3. 금리 표 (좌우 스크롤)" });
    expect(region.previousElementSibling?.textContent).toBe("← 표를 좌우로 넘겨 보세요");
  });
});
