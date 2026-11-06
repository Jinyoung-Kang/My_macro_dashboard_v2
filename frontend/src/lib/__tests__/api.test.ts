/**
 * 백엔드 주소 결정 — 화면을 연 호스트에 백엔드 포트를 붙입니다.
 *
 * 빌드 시점의 localhost:8080이 번들에 박혀 있으면 휴대폰(192.168.x.x:3000)은 자기 자신의
 * localhost를 찾고, LAN IP를 박으면 맥의 localhost:3000에서 쿠키가 다른 사이트가 됩니다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiBase, apiGet, apiPost, UnauthorizedError } from "@/lib/api";

describe("apiBase", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("브라우저에서는 화면을 연 호스트 + 백엔드 포트", () => {
    vi.stubGlobal("window", { location: { protocol: "http:", hostname: "192.168.0.10" } });
    expect(apiBase()).toBe("http://192.168.0.10:8080");

    vi.stubGlobal("window", { location: { protocol: "http:", hostname: "localhost" } });
    expect(apiBase()).toBe("http://localhost:8080");
  });

  it("서버(SSR)에서는 localhost", () => {
    vi.stubGlobal("window", undefined);
    expect(apiBase()).toBe("http://localhost:8080");
  });
});

describe("apiBase — NEXT_PUBLIC_API_BASE", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function apiBaseWith(value: string) {
    vi.stubEnv("NEXT_PUBLIC_API_BASE", value);
    vi.resetModules();
    return (await import("@/lib/api")).apiBase;
  }

  it("'/'는 같은 출처 — 상대 경로라 '//api'(다른 호스트로 읽힘)가 되지 않는다", async () => {
    const base = await apiBaseWith("/");
    vi.stubGlobal("window", { location: { protocol: "https:", hostname: "d1.cloudfront.net" } });
    expect(base()).toBe("");
    expect(`${base()}/api/x`).toBe("/api/x");
  });

  it("전체 주소는 그대로", async () => {
    const base = await apiBaseWith("https://api.example.test");
    expect(base()).toBe("https://api.example.test");
  });
});

describe("요청 헤더", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GET에는 Content-Type을 붙이지 않는다 — 붙이면 URL마다 preflight(OPTIONS)가 먼저 나간다", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { protocol: "http:", hostname: "localhost" } });

    await apiGet("/api/x");
    const getHeaders = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(getHeaders["Content-Type"]).toBeUndefined();

    await apiPost("/api/y", { a: 1 });
    const postHeaders = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(postHeaders["Content-Type"]).toBe("application/json");
  });
});

describe("401 응답", () => {
  afterEach(() => vi.unstubAllGlobals());

  // QA-044 재현 — 수정 전에는 401이면 본문을 읽지 않고 고정 문구("로그인이 필요합니다.")를 썼다.
  it("QA-044 401이어도 서버가 준 문구를 쓴다 — 비밀번호가 틀렸는데 '로그인이 필요합니다'가 뜨지 않게", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: false, message: "이메일 또는 비밀번호가 올바르지 않습니다." }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    )));
    vi.stubGlobal("window", { location: { protocol: "http:", hostname: "localhost" } });

    const failure = (await apiPost("/api/auth/login", { email: "a@b.c", password: "x" }).catch((e: unknown) => e)) as Error;

    expect(failure).toBeInstanceOf(UnauthorizedError);
    expect(failure.message).toBe("이메일 또는 비밀번호가 올바르지 않습니다.");
  });
});

describe("오류 본문의 코드", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("서버 오류 본문의 error 칸을 ApiError.code로 나른다 — 실제 매매 켜기 창이 코드별 문구를 고름(ADR 0028)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: false, error: "password-invalid", message: "비밀번호가 맞지 않습니다." }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    )));
    vi.stubGlobal("window", { location: { protocol: "http:", hostname: "localhost" } });

    const failure = (await apiPost("/api/realtrade/enable", {}).catch((e: unknown) => e)) as ApiError;

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.status).toBe(403);
    expect(failure.code).toBe("password-invalid");
    expect(failure.message).toBe("비밀번호가 맞지 않습니다.");
  });

  it("본문이 JSON이 아니면 code는 null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));
    vi.stubGlobal("window", { location: { protocol: "http:", hostname: "localhost" } });

    const failure = (await apiPost("/api/realtrade/enable", {}).catch((e: unknown) => e)) as ApiError;

    expect(failure.code).toBeNull();
    expect(failure.message).toBe("요청 실패 (HTTP 500)");
  });
});
