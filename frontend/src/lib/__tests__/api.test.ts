/**
 * 백엔드 주소 결정 — 화면을 연 호스트에 백엔드 포트를 붙입니다.
 *
 * 빌드 시점의 localhost:8080이 번들에 박혀 있으면 휴대폰(192.168.x.x:3000)은 자기 자신의
 * localhost를 찾고, LAN IP를 박으면 맥의 localhost:3000에서 쿠키가 다른 사이트가 됩니다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiBase, apiDelete, apiGet, apiGetShared, apiPatch, apiPost, NetworkError, UnauthorizedError } from "@/lib/api";

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

  it("PATCH는 메서드·JSON 본문·Content-Type을 보낸다(정보 검색 관심 대상의 별칭·알림 — 계약 §9-4·9-5)", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response("{\"ok\":true}", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { protocol: "http:", hostname: "localhost" } });

    await expect(apiPatch("/api/search/watch/7", { notify: true })).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/search\/watch\/7$/);
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ notify: true }));
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});

describe("QA-345 쓰기 요청의 시간 한도", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** 응답을 주지 않다가 취소 신호를 받으면 AbortError로 끝나는 fetch(브라우저와 같은 동작). */
  const hangingFetch = () =>
    vi.fn().mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));

  // 수정 전에는 apiPost가 한도를 받지 않아(셋째 인자를 버림) 응답이 오지 않으면 끝없이 기다렸다 — 실제 매매 끄기 단추가 '끄는 중…'으로 잠김.
  it("apiPost에 한도를 주면 그 시간 뒤 NetworkError(timedOut)로 끝난다", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    vi.stubGlobal("window", { location: { protocol: "http:", hostname: "localhost" } });

    const outcome = await Promise.race([
      apiPost("/api/realtrade/disable", { market: "KR" }, { timeoutMs: 30 }).catch((e: unknown) => e),
      new Promise((resolve) => setTimeout(() => resolve("아직 기다리는 중"), 400)),
    ]);

    expect(outcome).toBeInstanceOf(NetworkError);
    expect((outcome as ApiError).status).toBe(0);
    expect((outcome as Error).message).toMatch(/초 안에 응답하지 않았습니다/);
    expect((outcome as { timedOut?: boolean }).timedOut).toBe(true);
  });

  it("한도를 주지 않은 apiPost는 예전처럼 기다린다(다른 화면의 쓰기는 그대로)", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    vi.stubGlobal("window", { location: { protocol: "http:", hostname: "localhost" } });

    const outcome = await Promise.race([
      apiPost("/api/y", { a: 1 }).catch((e: unknown) => e),
      new Promise((resolve) => setTimeout(() => resolve("아직 기다리는 중"), 150)),
    ]);

    expect(outcome).toBe("아직 기다리는 중");
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
    expect(failure.body).toBeNull();
    expect(failure.message).toBe("요청 실패 (HTTP 500)");
  });

  it("서버 오류 본문 전체를 ApiError.body로 나른다 — 정보 검색 관심 대상 등록 503 partial의 받지 못한 출처(failed)를 화면이 읽음", async () => {
    const body = {
      ok: false, reason: "partial", message: "합성 사유",
      failed: [{ source: "dart_store", message: "DART 고유번호 저장본을 읽지 못함" }, { source: "wikidata", message: null }],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify(body),
      { status: 503, headers: { "Content-Type": "application/json" } },
    )));
    vi.stubGlobal("window", { location: { protocol: "http:", hostname: "localhost" } });

    const failure = (await apiPost("/api/search/watch", { key: "kr:005930" }).catch((e: unknown) => e)) as ApiError;

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.status).toBe(503);
    expect(failure.message).toBe("합성 사유");
    expect(failure.body).toEqual(body);
  });
});

describe("QA-1008 쓰기 뒤의 공유 GET", () => {
  afterEach(() => vi.unstubAllGlobals());

  /**
   * GET은 손으로 끝낼 때까지 기다리고(나간 순서대로 `gets`에 쌓임), 그 밖의 메서드는 곧바로 `writeStatus`(기본 200)를 주는 fetch.
   * `apiGetShared`를 목으로 두지 않고 실제 묶기를 지나게 한다.
   */
  function stubFetch(writeStatus = 200) {
    const gets: { url: string; resolve: (body: unknown) => void }[] = [];
    const fetchMock = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      if (init.method !== "GET") {
        return Promise.resolve(new Response("{\"ok\":true}", { status: writeStatus, headers: { "Content-Type": "application/json" } }));
      }
      return new Promise<Response>((resolve) => {
        gets.push({
          url,
          resolve: (body) => resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })),
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { protocol: "http:", hostname: "localhost" } });
    return gets;
  }

  // 수정 전에는 쓰기 뒤의 다시 읽기가 쓰기 전에 나간 같은 GET의 약속을 그대로 받아(요청 1번) 쓰기 전 값이 화면에 남았다.
  it.fails("쓰기가 끝난 뒤의 GET은 쓰기 전에 나간 같은 GET에 합류하지 않는다", async () => {
    const gets = stubFetch();

    const before = apiGetShared<{ mode: string }>("/api/qa1008/state");
    await apiPost("/api/qa1008/enable", { on: true });
    const after = apiGetShared<{ mode: string }>("/api/qa1008/state");

    expect(gets).toHaveLength(2);
    expect(after).not.toBe(before);
    gets[0].resolve({ mode: "OFF" });   // 쓰기 전에 나간 요청의 응답(옛 값)
    gets[1].resolve({ mode: "LIVE" });  // 쓰기 뒤에 나간 요청의 응답
    await expect(before).resolves.toEqual({ mode: "OFF" });
    await expect(after).resolves.toEqual({ mode: "LIVE" });
  });

  it.fails("실패한 쓰기 뒤에도 새로 읽는다 — 서버가 처리했을 수 있다", async () => {
    const gets = stubFetch(500);

    const before = apiGetShared("/api/qa1008/list");
    await expect(apiDelete("/api/qa1008/list/1")).rejects.toBeInstanceOf(ApiError);
    const after = apiGetShared("/api/qa1008/list");

    expect(gets).toHaveLength(2);
    expect(after).not.toBe(before);
    gets.forEach((get) => get.resolve([]));
    await Promise.all([before, after]);
  });

  it("쓰기가 없으면 진행 중인 같은 GET을 함께 쓴다(요청 한 번) — 시간 한도가 다르면 따로", async () => {
    const gets = stubFetch();

    const first = apiGetShared("/api/qa1008/shared");
    const second = apiGetShared("/api/qa1008/shared");
    const other = apiGetShared("/api/qa1008/shared", 5000);

    expect(second).toBe(first);
    expect(other).not.toBe(first);
    expect(gets).toHaveLength(2);
    expect(gets[0].url).toMatch(/\/api\/qa1008\/shared$/);
    gets.forEach((get) => get.resolve({ n: 1 }));
    await expect(Promise.all([first, second, other])).resolves.toEqual([{ n: 1 }, { n: 1 }, { n: 1 }]);
  });

  it("GET은 쓰기 차례를 올리지 않는다 — 다른 GET이 끝나도 진행 중인 GET은 계속 함께 쓴다", async () => {
    const gets = stubFetch();

    const first = apiGetShared("/api/qa1008/slow");
    const quick = apiGet("/api/qa1008/quick");
    gets[1].resolve({});
    await quick;
    const second = apiGetShared("/api/qa1008/slow");

    expect(second).toBe(first);
    expect(gets).toHaveLength(2);
    gets[0].resolve({});
    await first;
  });
});
