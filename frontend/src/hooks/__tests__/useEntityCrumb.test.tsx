/**
 * 빵부스러기 대상 이름 저장소(hooks/useEntityCrumb — P4): 상세 화면이 넣고 셸이 읽습니다.
 * 넣기·이름 바꾸기·떠날 때 지우기(그 주소일 때만 — 상세 → 상세로 옮길 때 새 화면 것을 지우지 않음)·이름 모름(null)이면 넣지 않음·Strict Mode 두 번 효과.
 */
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { resetEntityCrumbForTest, useEntityCrumb, useEntityCrumbLabel } from "../useEntityCrumb";

afterEach(() => {
  cleanup();
  act(() => resetEntityCrumbForTest());
});

function Detail({ href, label }: { href: string | null; label: string | null }) {
  useEntityCrumb(href, label);
  return null;
}

function Reader({ onRead }: { onRead: (value: ReturnType<typeof useEntityCrumbLabel>) => void }) {
  onRead(useEntityCrumbLabel());
  return null;
}

describe("useEntityCrumb", () => {
  it("넣고 읽는다 — 이름이 바뀌면 따라오고, 떠나면 지운다", () => {
    const read = renderHook(() => useEntityCrumbLabel());
    expect(read.result.current).toBeNull();
    const detail = render(<Detail href="/s/kr/005930" label="005930" />);
    expect(read.result.current).toEqual({ href: "/s/kr/005930", label: "005930" });
    detail.rerender(<Detail href="/s/kr/005930" label="삼성전자" />);
    expect(read.result.current).toEqual({ href: "/s/kr/005930", label: "삼성전자" });
    detail.unmount();
    expect(read.result.current).toBeNull();
  });

  it("주소나 이름을 모르면(null) 넣지 않는다", () => {
    const read = renderHook(() => useEntityCrumbLabel());
    render(<Detail href="/institutions/1067983" label={null} />);
    expect(read.result.current).toBeNull();
    render(<Detail href={null} label="이름" />);
    expect(read.result.current).toBeNull();
  });

  it("상세 → 상세로 옮길 때 새 화면이 먼저 넣었으면 앞 화면이 떠나며 지우지 않는다", () => {
    const read = renderHook(() => useEntityCrumbLabel());
    const first = render(<Detail href="/s/kr/005930" label="삼성전자" />);
    render(<Detail href="/s/kr/000660" label="SK하이닉스" />);
    expect(read.result.current).toEqual({ href: "/s/kr/000660", label: "SK하이닉스" });
    first.unmount();
    expect(read.result.current).toEqual({ href: "/s/kr/000660", label: "SK하이닉스" });
  });

  it("Strict Mode의 두 번 효과(넣기 → 지우기 → 넣기)도 같은 값으로 끝난다", () => {
    const seen: (ReturnType<typeof useEntityCrumbLabel>)[] = [];
    const wrap = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    render(
      <>
        <Detail href="/markets/i/vix" label="VIX" />
        <Reader onRead={(value) => seen.push(value)} />
      </>,
      { wrapper: wrap },
    );
    expect(seen.at(-1)).toEqual({ href: "/markets/i/vix", label: "VIX" });
  });

  it("서버 렌더 값은 null(주소의 식별자 그대로)", () => {
    act(() => {
      render(<Detail href="/markets/i/vix" label="VIX" />);
    });
    let value: ReturnType<typeof useEntityCrumbLabel> | undefined;
    renderToString(<Reader onRead={(next) => (value = next)} />);
    expect(value).toBeNull();
  });
});
