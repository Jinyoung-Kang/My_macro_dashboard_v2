/**
 * 쪽 넘기기 '다음'·'이전'으로 끝 쪽에 닿을 때의 포커스 — QA-890(D6 전 QA 스택 확인에서 찾음, 개편 전부터 — D5 '출처 카드 쪽'도 같음).
 *
 * 공용 Pager(정보 수집 화면들 — 출처 표·KRX·네이버·메커니즘·거장 견해·뉴스 목록)는 끝 쪽에서 '다음'(첫 쪽에서 '이전')을 disabled로 바꿉니다. 그 단추로
 * 끝 쪽에 가면 누른 단추가 꺼져 크롬이 포커스를 body로 보냈습니다(/info/global·paper·kr 1→2/2쪽, /info/status 7/7쪽 — 모든 폭). 진행 기록의
 * `info-news-pager-focus-body`(뉴스 목록이 쪽을 읽는 동안 Loading으로 바뀌어 Pager가 사라지는 꼴)와는 다른 원인입니다.
 *
 * 기대: 누른 '다음'·'이전'이 꺼지면 포커스는 지금 쪽 번호 단추(aria-current="page")로 — 쪽 nav 안에 남습니다. 꺼지지 않는 넘김은 포커스를 옮기지 않습니다.
 * jsdom은 disabled가 된 단추에서 포커스를 빼지 않으므로 활성 요소가 꺼진 단추인지를 봅니다(크롬은 그 순간 body로 보냄).
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 두 사례 모두 'expected <button type="button" …(2)></button> to be <button type="button" …(2)></button>'
 * (활성 요소가 꺼진 '다음'·'이전' — 지금 쪽 번호가 아님).
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { Pager } from "@/components/Pager";

afterEach(() => cleanup());

function Host({ start, pages }: { start: number; pages: number }) {
  const [page, setPage] = useState(start);
  return <Pager page={page} pages={pages} onChange={setPage} label="출처" />;
}

const nav = () => screen.getByRole("navigation", { name: "출처 쪽" });

describe("쪽 넘기기 끝 쪽 포커스(QA-890)", () => {
  it("'다음'으로 마지막 쪽에 닿으면 지금 쪽 번호로, 그 전 넘김은 '다음'에 그대로", () => {
    render(<Host start={1} pages={3} />);
    const next = within(nav()).getByRole("button", { name: "다음" });
    next.focus();
    act(() => fireEvent.click(next));
    expect(within(nav()).getByRole("button", { name: "2" }).getAttribute("aria-current")).toBe("page");
    expect(document.activeElement).toBe(next);
    act(() => fireEvent.click(next));
    expect((next as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(within(nav()).getByRole("button", { name: "3" }));
    expect(document.activeElement?.getAttribute("aria-current")).toBe("page");
  });

  it("'이전'으로 첫 쪽에 닿으면 지금 쪽 번호 1로", () => {
    render(<Host start={2} pages={2} />);
    const previous = within(nav()).getByRole("button", { name: "이전" });
    previous.focus();
    act(() => fireEvent.click(previous));
    expect((previous as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(within(nav()).getByRole("button", { name: "1" }));
  });
});
