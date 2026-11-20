/**
 * 오류 상자 '다시 시도' 뒤 포커스 — QA-901(D2 '다시 시도 뒤 포커스'(P7 공용 — 상세 셋·기관 화면 자리) — 작업대 P8 키보드 경로, 개편 전부터).
 *
 * 공용 `ErrorState`의 '다시 시도'를 누르면 공용 `useApi`가 오류를 지우고 다시 읽으므로, 화면은 오류 상자를 '불러오는 중'(Loading)으로 바꿉니다 — 누른
 * 단추가 사라져 크롬이 포커스를 body로 보냈고, 다음 Tab은 문서 처음(본문으로 건너뛰기)부터 다시 시작했습니다.
 *
 * 기대(규칙 — 쪽 넘김 QA-902와 같음): 포커스를 가진 조작이 다시 읽기를 시작해 그 조작이 사라지면, 다시 읽기를 시작한 자리의 제목으로 — 남아 있는 가장 가까운
 * 조상 패널(section)의 머리 제목, 패널까지 사라졌으면 본문(main)의 화면 제목(h1), 그것도 없으면 본문(main — 건너뛰기 링크의 목적지) 자체로 옮깁니다.
 * 포커스가 단추에 없던 누름(마우스로 누른 뒤 다른 곳을 고른 경우 등)이나, 사라지지 않은 조작은 건드리지 않습니다.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 세 사례 모두 'expected <body>…(1)</body> to be <h2 …(1)>…(1)</h2>' 꼴(활성 요소 body).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { ErrorState, Loading, PageHeader, Panel } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import InfoHub from "@/components/screens/info/InfoHub";

/** 패널 안 목록 — 값이 없을 때 오류면 오류 상자, 읽는 중이면 Loading(화면들의 흔한 꼴). */
function PanelList() {
  const read = useApi<{ text: string }>("/api/synthetic/list");
  return (
    <Panel title="합성 목록">
      {read.error ? <ErrorState message={read.error} onRetry={read.reload} /> : read.loading && !read.data ? <Loading /> : <p>{read.data?.text}</p>}
    </Panel>
  );
}

/** 화면 전체가 오류 상자로 바뀌는 꼴(`if (error) return <ErrorState …/>` — 머리까지 사라짐). */
function WholePage() {
  const read = useApi<{ text: string }>("/api/synthetic/page");
  if (read.loading && !read.data) return <Loading />;
  if (read.error) return <ErrorState message={read.error} onRetry={read.reload} />;
  return <PageHeader title="합성 화면" />;
}

beforeEach(() => {
  api.apiGetShared.mockReset();
});
afterEach(() => cleanup());

/** 첫 읽기는 실패, 그다음 읽기는 끝나지 않음(다시 읽는 동안을 봄). */
function failThenPending() {
  api.apiGetShared.mockImplementationOnce(() => Promise.reject(new Error("합성 실패"))).mockImplementation(() => new Promise(() => {}));
}

async function pressRetry() {
  const retry = await screen.findByRole("button", { name: "다시 시도" });
  retry.focus();
  expect(document.activeElement).toBe(retry);
  await act(async () => fireEvent.click(retry));
}

describe("'다시 시도' 뒤 포커스(QA-901)", () => {
  it("패널 안 오류 상자 — 패널 머리 제목으로", async () => {
    failThenPending();
    render(<PanelList />);
    await pressRetry();
    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "합성 목록" })));
  });

  it("화면 전체 오류 상자 — 본문(main)으로(화면 제목이 아직 없음)", async () => {
    failThenPending();
    render(
      <main id="main" tabIndex={-1}>
        <WholePage />
      </main>,
    );
    await pressRetry();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("main")));
  });

  it("정보 수집 뉴스 목록의 오류 상자 — '뉴스·글' 패널 제목으로", async () => {
    api.apiGetShared.mockImplementation((path: string) => {
      if (path.startsWith("/api/info/catalog")) return Promise.resolve({ checkedAt: null, collectorReachable: true, tabs: [], sources: [], incidents: [] });
      if (path.startsWith("/api/info/items?kind=blog")) return api.apiGetShared.mock.calls.filter(([p]) => String(p).startsWith("/api/info/items?kind=blog")).length === 1
        ? Promise.reject(new Error("합성 실패"))
        : new Promise(() => {});
      return new Promise(() => {});
    });
    render(<InfoHub tab="news" />);
    await pressRetry();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "뉴스·글", level: 2 })));
  });

  it("포커스가 없던 누름은 포커스를 옮기지 않는다", async () => {
    failThenPending();
    render(<PanelList />);
    const retry = await screen.findByRole("button", { name: "다시 시도" });
    await act(async () => fireEvent.click(retry));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(document.activeElement).toBe(document.body);
  });
});
