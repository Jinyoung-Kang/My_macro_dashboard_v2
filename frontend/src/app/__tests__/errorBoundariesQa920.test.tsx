/**
 * 렌더 예외의 화면 — QA-920(작업대 P8 갈래 C).
 *
 * 앱에 오류 경계 파일(`error.tsx`·`global-error.tsx`)이 없어, 화면을 그리다 예외가 나면 Next 기본 화면(흰 판의 영어 'Application error: a client-side
 * exception has occurred…' — 어두운 고정 테마·한국어 화면과 맞지 않고 돌아갈 길이 없음)이 떴습니다. 없는 주소의 Next 기본 404를 고친 QA-270·QA-864와
 * 같은 묶음입니다(진행 기록 §P4 '다음 단계로 넘긴 것' — 루트·셸 안 not-found·error·global-error 한 묶음).
 *
 * 기대(Next 16.4 규약 — 설치된 next의 docs/01-app/03-api-reference/03-file-conventions/error.md·client/components/error-boundary.d.ts):
 * - 세 파일 모두 클라이언트 컴포넌트('use client')이고 받는 값은 `{ error: unknown, reset, retry }`(이 시험은 Next의 ErrorComponent 형에 대입해 tsc로도 봄).
 * - 셸 안(`app/(dashboard)/error.tsx`): 셸 안 not-found(QA-864)와 같은 꼴 — 자기 `<main>` 없이 화면 머리 h1·안내 한 줄·'다시 시도' 단추·홈 링크 하나.
 * - 루트(`app/error.tsx` — 대시보드 레이아웃 자체·로그인 밖 화면의 예외): 루트 not-found(QA-270)와 같은 인증 카드 틀 — 같은 글·'다시 시도'·홈 링크.
 * - 전체(`app/global-error.tsx` — 루트 레이아웃의 예외): 루트 레이아웃을 대신하므로 `<html lang="ko">`·`<body>`(루트와 같은 바탕 클래스)를 스스로 그리고
 *   전역 CSS를 가져오며, metadata를 쓸 수 없어 `<title>`을 둡니다. 안은 루트와 같은 카드.
 * - '다시 시도'는 경계의 retry를 부르고(고장 주입 — 자식이 throw하는 화면을 경계 안에 그림), 다시 그린 자식이 이번에는 그려지면 카드가 사라집니다.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 'app/(dashboard)/error.tsx: expected false to be true'(파일 없음 — 셋 모두 같은 꼴).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ErrorComponent } from "next/dist/client/components/error-boundary";
import { Component, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { belowLgTarget } from "@/lib/__tests__/touchTargetAudit";
import { APP_TITLE } from "@/lib/nav";

const APP = resolve(__dirname, "..");
const FILES = {
  dashboard: resolve(APP, "(dashboard)/error.tsx"),
  root: resolve(APP, "error.tsx"),
  global: resolve(APP, "global-error.tsx"),
} as const;

const TITLE = "화면을 표시하지 못했습니다";
const TEXT = "화면을 그리는 중 문제가 생겼습니다. 다시 시도해도 같으면 홈에서 다시 찾아 주세요.";

async function load(file: string): Promise<ErrorComponent> {
  expect(existsSync(file), file.slice(APP.length + 1)).toBe(true);
  const mod = (await import(/* @vite-ignore */ file)) as { default: ErrorComponent };
  return mod.default;
}

/**
 * 시험용 오류 경계 — Next의 경계(client/components/error-boundary)처럼 잡은 값을 `error`로, 상태를 지우는 `reset`·다시 받아 그리는 `retry`를 넘깁니다
 * (여기서 retry는 상태만 지움 — 서버에서 다시 받을 것이 없음). 화면이 부르는 retry의 수를 onRetry로 알립니다(reset은 부르면 안 됨 — 던짐).
 */
class Boundary extends Component<
  { fallback: ErrorComponent; onRetry: () => void; children: ReactNode },
  { caught: { error: unknown } | null }
> {
  state: { caught: { error: unknown } | null } = { caught: null };
  static getDerivedStateFromError(error: unknown) {
    return { caught: { error } };
  }
  reset = () => {
    throw new Error("reset이 아니라 retry를 불러야 합니다");
  };
  retry = () => {
    this.props.onRetry();
    this.setState({ caught: null });
  };
  render() {
    const Fallback = this.props.fallback;
    return this.state.caught ? (
      <Fallback error={this.state.caught.error} reset={this.reset} retry={this.retry} />
    ) : (
      this.props.children
    );
  }
}

/** 고장 주입 — broken이 참인 동안 그릴 때 던집니다. */
const fault = { broken: true };
function Bomb() {
  if (fault.broken) throw new Error("고장 주입");
  return <p>다시 그린 화면</p>;
}

function renderBroken(Fallback: ErrorComponent, onRetry: () => void) {
  return render(
    <Boundary fallback={Fallback} onRetry={onRetry}>
      <Bomb />
    </Boundary>,
  );
}

beforeEach(() => {
  fault.broken = true;
  // React가 잡은 렌더 예외를 console.error로 알립니다 — 의도한 고장이라 조용히.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => cleanup());

describe("렌더 예외의 화면(QA-920)", () => {
  it("세 경계 파일이 있고 모두 클라이언트 컴포넌트다", () => {
    for (const file of Object.values(FILES)) {
      expect(existsSync(file), file.slice(APP.length + 1)).toBe(true);
      expect(readFileSync(file, "utf8")).toMatch(/^\s*(?:\/\*[\s\S]*?\*\/\s*)?["']use client["']/);
    }
  });

  it("셸 안: 화면 머리 h1·안내·'다시 시도'(retry)·홈 링크 하나 — 자기 <main> 없음, 누름 자리 좁은 화면 44px", async () => {
    const DashboardError = await load(FILES.dashboard);
    const onRetry = vi.fn();
    renderBroken(DashboardError, onRetry);
    expect(screen.getByRole("heading", { level: 1, name: TITLE })).toBeTruthy();
    expect(screen.queryByRole("main")).toBeNull();
    expect(screen.getByText(TEXT).className).toContain("break-keep");
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/"]);
    const home = screen.getByRole("link", { name: "← 홈" });
    expect(belowLgTarget(home.getAttribute("class") ?? "")).toBeNull();
    const retry = screen.getByRole("button", { name: "다시 시도" });
    expect(belowLgTarget(retry.getAttribute("class") ?? "")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Application error|client-side exception|Something went wrong/);

    fault.broken = false;
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByText("다시 그린 화면")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: TITLE })).toBeNull();
  });

  it("다시 시도해도 또 던지면 카드가 그대로 남는다(retry만 — 다른 쓰기·이동 없음)", async () => {
    const DashboardError = await load(FILES.dashboard);
    const onRetry = vi.fn();
    renderBroken(DashboardError, onRetry);
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { level: 1, name: TITLE })).toBeTruthy();
  });

  it("루트: 루트 not-found와 같은 인증 카드(<main>·h1)·안내·'다시 시도'(retry)·홈 링크 하나", async () => {
    const RootError = await load(FILES.root);
    const onRetry = vi.fn();
    renderBroken(RootError, onRetry);
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: TITLE })).toBeTruthy();
    expect(screen.getByText(TEXT).className).toContain("break-keep");
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/"]);
    expect(belowLgTarget(screen.getByRole("link", { name: "← 홈" }).getAttribute("class") ?? "")).toBeNull();

    fault.broken = false;
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByText("다시 그린 화면")).toBeTruthy();
  });

  it("서버 오류의 digest가 있으면 '오류 번호'로 적고, 메시지는 적지 않는다", async () => {
    const RootError = await load(FILES.root);
    const error = Object.assign(new Error("내부 경로 /secret"), { digest: "123456789" });
    render(<RootError error={error} reset={() => {}} retry={() => {}} />);
    expect(screen.getByText("오류 번호 123456789")).toBeTruthy();
    expect(document.body.textContent).not.toContain("/secret");
  });

  it("전체: <html lang=\"ko\">·<body>(루트 레이아웃과 같은 바탕)·<title>을 스스로 그리고 전역 CSS를 가져온다, 안은 루트와 같은 카드", async () => {
    const source = readFileSync(FILES.global, "utf8");
    expect(source).toMatch(/import\s+["']\.\/globals\.css["']/);
    const GlobalError = await load(FILES.global);
    const html = renderToStaticMarkup(<GlobalError error={new Error("x")} reset={() => {}} retry={() => {}} />);
    expect(html).toMatch(/^<html lang="ko">/);
    const rootLayout = readFileSync(resolve(APP, "layout.tsx"), "utf8");
    const bodyClass = /<body className="([^"]+)"/.exec(rootLayout)?.[1];
    expect(bodyClass).toBeTruthy();
    expect(html).toContain(`<body class="${bodyClass}">`);
    // 앱 이름은 lib/nav APP_TITLE과 같은 글(전체 경계 묶음에 메뉴 모듈을 싣지 않으려고 글로 둠 — lib/errorScreen).
    expect(html).toContain(`<title>${TITLE} · ${APP_TITLE}</title>`);
    expect(html).toContain(`<h1`);
    expect(html).toContain(TITLE);
    expect(html).toContain(TEXT);
    expect(html).toContain('href="/"');
    expect(html).toMatch(/<button type="button"[^>]*>다시 시도<\/button>/);
  });
});
