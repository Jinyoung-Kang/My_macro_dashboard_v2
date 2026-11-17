/**
 * 정보 검색 본문 보기(ADR 0043) — 미리 보기의 '원문 열기' 옆 '본문 보기'(운영자만)와 본문 팝업. 수집 글은 같은 이름으로 받아 둔 원문 팝업, 기사·글 줄은
 * 운영 서버가 받는 동안 다시 묻고(받는 중 → 받음), 실패면 사유와 원문 열기, 일시 실패는 남은 초 동안 다시 시도를 잠금, 상한까지 받는 중이면 '다시 확인',
 * 한국어가 아닌 글만 번역 단추, Escape는 팝업만 닫고 포커스를 '본문 보기'로 돌려주며, 닫으면 다시 묻기를 멈춘다.
 * 응답은 모두 합성 값입니다(실제 기사 글을 쓰지 않음 — ADR 0026 결정 12).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("next/navigation", () => import("./fakeNavigation"));

import { ARTICLE_POLLING } from "@/hooks/useArticleBody";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { SearchArticle, SearchArticleResponse, SearchFeedItem, SessionUser } from "@/lib/types";
import { SearchScreen } from "../SearchScreen";
import { setLocation } from "./fakeNavigation";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const OWNER: SessionUser = { email: "o@test.local", role: "OWNER", tier: "PRO" };
const REF_EN = "0123456789abcdef0123456789abcdef";
const REF_KO = "fedcba9876543210fedcba9876543210";
const READER = "0123456789abcdef01234567";

const NVIDIA = {
  key: "us:NVDA", kind: "company", name: "엔비디아", nameKo: "엔비디아", nameEn: "NVIDIA Corp", aliases: ["NVIDIA", "엔비디아"],
  description: null,
  ids: { ticker: "NVDA", market: "us", stockCode: null, cik: "0001045810", dartCorpCode: null, wikidata: "Q182477", lei: null },
  links: [],
  sources: ["sec", "wikidata"],
};

function row(over: Partial<SearchFeedItem>): SearchFeedItem {
  return {
    id: "r", kind: "news", title: "제목", url: "https://news.example/a", publisher: "Example Wire", publisherDomain: "news.example",
    publishedAt: "2026-11-14T00:30:00+00:00", timeBasis: "published", source: "bing", lang: "en", summary: null, readerId: null,
    bodyRef: null, bodyNote: null, ...over,
  };
}

const FEED = {
  available: true, entityKey: "us:NVDA", tab: "timeline",
  items: [
    row({ id: "e1", title: "Synthetic Widgets revenue rises", url: "https://news.example/e1", bodyRef: REF_EN }),
    row({ id: "k1", title: "합성전자 분기 매출 늘어", url: "https://news.example/k1", lang: "ko", bodyRef: REF_KO,
      publishedAt: "2026-11-13T23:00:00+00:00" }),
    row({ id: "n1", title: "네이버 합성 기사", url: "https://n.news.naver.com/x", source: "naver", publishedAt: "2026-11-13T22:00:00+00:00",
      bodyNote: "네이버 글은 받지 않습니다" }),
    row({ id: "q1", title: "받아 둔 글 하나", kind: "post", source: "info", readerId: READER, publishedAt: "2026-11-13T21:00:00+00:00" }),
  ],
  sources: [{ source: "bing", label: "Bing 뉴스", status: "ok", count: 3, dropped: null, message: null }],
  window: { from: "2024-11-14", to: "2026-11-14" }, rangeCounts: { "7d": 4, "30d": 4, "1y": 4, "2y": 4 },
  olderOnlyLatest: null, pending: false, fetchedAt: "2026-11-14T01:00:00+00:00",
};

function article(over: Partial<SearchArticle> = {}): SearchArticle {
  return {
    title: "Synthetic Widgets revenue rises", siteName: "Example Ledger", author: "Jane Placeholder", publishedDate: "2026-11-15", lang: "en",
    paragraphs: ["First synthetic paragraph.", "Second synthetic paragraph.", "Third synthetic paragraph."], chars: 80, totalChars: 80,
    truncated: false, short: false, paywalled: false, sourceUrl: "https://news.example/e1", sourceHost: "news.example", viaGoogle: false,
    fetchedAt: "2026-11-17T03:05:00+00:00", cached: false, ...over,
  };
}

const pending = (ref: string): SearchArticleResponse => ({ available: true, ref, status: "pending", reason: null, message: "받는 중", retryable: false,
  retryAfterSeconds: null, article: null });
const ok = (ref: string, body: SearchArticle): SearchArticleResponse => ({ available: true, ref, status: "ok", reason: null, message: null,
  retryable: false, retryAfterSeconds: null, article: body });
const failed = (ref: string, reason: string, message: string | null, retryable = false, retryAfterSeconds: number | null = null):
  SearchArticleResponse => ({ available: true, ref, status: "error", reason, message, retryable, retryAfterSeconds, article: null });

let reads: Record<string, unknown>;
/** 본문 보기 응답 — 꼬리표마다 차례로(마지막 것은 되풀이). */
let answers: Record<string, SearchArticleResponse[]>;
let articleCalls: string[];
let translateCalls: string[];

function serve(path: string): Promise<unknown> {
  const hit = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
  return hit ? Promise.resolve(reads[hit]) : new Promise(() => {});
}

function renderScreen(user: SessionUser = OWNER) {
  setLocation("/search?e=us:NVDA&tab=timeline&range=30d");
  return render(
    <SessionUserProvider user={user}>
      <SearchScreen />
    </SessionUserProvider>,
  );
}

beforeEach(() => {
  ARTICLE_POLLING.intervalMs = 5;
  ARTICLE_POLLING.maxPolls = 35;
  reads = {};
  answers = {};
  articleCalls = [];
  translateCalls = [];
  api.apiGet.mockReset();
  api.apiPost.mockReset();
  api.apiDelete.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => serve(path));
  api.apiGet.mockImplementation((path: string) => serve(path));
  api.apiPost.mockImplementation((path: string, body: { ref?: string }) => {
    if (path === endpoints.search.article && body?.ref) {
      articleCalls.push(body.ref);
      const queue = answers[body.ref] ?? [pending(body.ref)];
      return Promise.resolve(queue.length > 1 ? queue.shift() : queue[0]);
    }
    if (path === endpoints.search.articleTranslate && body?.ref) {
      translateCalls.push(body.ref);
      return Promise.resolve({ ok: true, titleKo: "합성 위젯 매출 증가", textKo: "첫 문단.\n\n둘째 문단.", alreadyKorean: false, cached: false,
        truncated: false, model: "gemini-3.5-flash", models: ["gemini-3.5-flash"], error: null });
    }
    return Promise.resolve({});
  });
  reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
  reads[endpoints.search.feed("us:NVDA", "timeline")] = FEED;
  reads[endpoints.info.item(READER)] = { available: true, item: { id: READER, body: "받아 둔 본문", summary: null } };
});
afterEach(() => {
  cleanup();
  ARTICLE_POLLING.intervalMs = 2_000;
  ARTICLE_POLLING.maxPolls = 35;
});

async function preview(title: RegExp, user: SessionUser = OWNER) {
  renderScreen(user);
  const list = await screen.findByRole("listbox", { name: "결과" });
  fireEvent.click(within(list).getByRole("option", { name: title }));
  return { list, region: screen.getByRole("region", { name: "미리 보기" }) };
}

describe("미리 보기의 '본문 보기'", () => {
  it("회원에게는 없다 — 꼬리표가 와도(백엔드가 지우지만 화면도 한 번 더)", async () => {
    const { region } = await preview(/Synthetic Widgets revenue rises/, MEMBER);
    expect(within(region).queryByRole("button", { name: "본문 보기" })).toBeNull();
    expect(within(region).getByText("기사 본문은 받지 않습니다 — 제목·매체·시각·요약만입니다.")).toBeTruthy();
    expect(articleCalls).toEqual([]);
  });

  it("운영자에게는 '원문 열기' 바로 다음 차례에 있고 안내 글이 바뀐다", async () => {
    const { region } = await preview(/Synthetic Widgets revenue rises/);
    const link = within(region).getByRole("link", { name: /원문 열기/ });
    const button = within(region).getByRole("button", { name: "본문 보기" });
    expect(link.nextElementSibling).toBe(button);
    expect(within(region).getByText(/누를 때 운영 서버가 이 글 한 건을 받아 본문만 추려 보입니다 — 저장하지 않습니다/)).toBeTruthy();
    expect(articleCalls).toEqual([]);
  });

  it("받지 않는 매체는 단추 없이 그 까닭 한 줄 — 같은 뜻의 안내 줄을 겹쳐 두지 않고, 한국어는 낱말 사이에서만 꺾는다", async () => {
    const { region } = await preview(/네이버 합성 기사/);
    expect(within(region).queryByRole("button", { name: "본문 보기" })).toBeNull();
    const note = within(region).getByText("본문 보기 없음: 네이버 글은 받지 않습니다");
    expect(note.className).toContain("break-keep");
    expect(within(region).queryByText(/기사 본문은 받지 않습니다/)).toBeNull();
  });

  it("수집 글은 같은 이름의 단추가 받아 둔 원문 팝업을 연다(받기 경로를 부르지 않음) — 두 단추 모두 대화상자를 연다고 알린다", async () => {
    const { region } = await preview(/받아 둔 글 하나/);
    expect(within(region).getByRole("button", { name: "본문 보기" }).getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(within(region).getByRole("button", { name: "본문 보기" }));
    const dialog = await screen.findByRole("dialog", { name: "받아 둔 글 하나" });
    expect(await within(dialog).findByText("받아 둔 본문")).toBeTruthy();
    expect(articleCalls).toEqual([]);
  });
});

describe("본문 팝업", () => {
  it("누르면 받는 중 → 다시 물어 받음 — 문단·글 언어·출처 링크(새 창, noopener noreferrer)", async () => {
    answers[REF_EN] = [pending(REF_EN), pending(REF_EN), ok(REF_EN, article())];
    const { region } = await preview(/Synthetic Widgets revenue rises/);
    fireEvent.click(within(region).getByRole("button", { name: "본문 보기" }));
    const dialog = await screen.findByRole("dialog", { name: "Synthetic Widgets revenue rises" });
    expect(within(dialog).getByRole("status").textContent).toContain("운영 서버가 글을 받는 중입니다");
    const body = await within(dialog).findByRole("region", { name: "본문" }, { timeout: 2000 });
    expect(body.getAttribute("lang")).toBe("en");
    // 스크롤은 대화상자 하나만 — 본문 상자는 따로 스크롤하지 않고(높이 상한·스크롤 없음) 탭 정지점도 아님.
    expect(body.getAttribute("tabindex")).toBeNull();
    expect(body.className).not.toMatch(/overflow-y-auto|max-h-/);
    expect(within(dialog).getByRole("heading", { name: "Synthetic Widgets revenue rises" }).getAttribute("lang")).toBe("en");
    expect(body.querySelectorAll("p")).toHaveLength(3);
    expect(articleCalls).toEqual([REF_EN, REF_EN, REF_EN]);
    const source = within(dialog).getByRole("link", { name: /원문 열기\(새 창\)/ });
    expect(source.getAttribute("href")).toBe("https://news.example/e1");
    expect(source.getAttribute("target")).toBe("_blank");
    expect(source.getAttribute("rel")).toBe("noopener noreferrer");
    expect(within(dialog).getByText("Example Ledger")).toBeTruthy();
    expect(within(dialog).getByText("2026-11-17 12:05 KST")).toBeTruthy();
    expect(within(dialog).getByText(/저작권은 원 매체에 있습니다/)).toBeTruthy();
  });

  it("실패하면 사유와 원문 열기 — 다시 시도는 잠시 뒤 될 수 있는 사유에만", async () => {
    answers[REF_EN] = [failed(REF_EN, "blocked", "news.example가 요청을 거부했습니다(HTTP 403) — 6시간 동안 이 매체는 다시 묻지 않습니다")];
    const { region } = await preview(/Synthetic Widgets revenue rises/);
    fireEvent.click(within(region).getByRole("button", { name: "본문 보기" }));
    const dialog = await screen.findByRole("dialog");
    const reason = await within(dialog).findByText(/요청을 거부했습니다\(HTTP 403\)/, { selector: "span" });
    expect(reason.className).toContain("break-keep");
    expect(within(dialog).getByRole("link", { name: /원문 열기\(새 창\)/ }).getAttribute("href")).toBe("https://news.example/e1");
    expect(within(dialog).queryByRole("button", { name: "다시 시도" })).toBeNull();
  });

  it("일시 실패는 남은 초 동안 '다시 시도'를 잠그고 그 까닭을 적은 뒤 풀어 준다", async () => {
    answers[REF_EN] = [failed(REF_EN, "timeout", "news.example의 응답이 늦어 끊었습니다", true, 1), ok(REF_EN, article())];
    const { region } = await preview(/Synthetic Widgets revenue rises/);
    fireEvent.click(within(region).getByRole("button", { name: "본문 보기" }));
    const dialog = await screen.findByRole("dialog");
    const retry = await within(dialog).findByRole("button", { name: "다시 시도" });
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText(/약 1초 동안 다시 시도를 잠가 둡니다/)).toBeTruthy();
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "다시 시도" }) as HTMLButtonElement).disabled).toBe(false),
      { timeout: 2500 });
    fireEvent.click(within(dialog).getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(within(dialog).getByLabelText("본문").querySelectorAll("p")).toHaveLength(3));
  });

  it("상태 줄 하나가 단계와 상관없이 붙어 받는 중 → 받음·실패를 알린다(aria-busy 밖)", async () => {
    answers[REF_EN] = [pending(REF_EN), ok(REF_EN, article())];
    const { region } = await preview(/Synthetic Widgets revenue rises/);
    fireEvent.click(within(region).getByRole("button", { name: "본문 보기" }));
    const dialog = await screen.findByRole("dialog");
    const status = within(dialog).getByRole("status");
    expect(status.textContent).toBe("운영 서버가 글을 받는 중입니다");
    expect(status.closest("[aria-busy='true']")).toBeNull();
    await waitFor(() => expect(within(dialog).getByRole("status").textContent).toBe("본문을 받았습니다(문단 3개)"));
    expect(within(dialog).getByRole("status")).toBe(status);
    cleanup();

    answers[REF_EN] = [pending(REF_EN), failed(REF_EN, "no_body", "본문을 찾지 못했습니다")];
    const again = await preview(/Synthetic Widgets revenue rises/);
    fireEvent.click(within(again.region).getByRole("button", { name: "본문 보기" }));
    const next = await screen.findByRole("dialog");
    await waitFor(() => expect(within(next).getByRole("status").textContent).toBe("받지 못했습니다: 본문을 찾지 못했습니다"));
    expect(within(next).getAllByRole("status")).toHaveLength(1);
  });

  it("'다시 시도'를 누르면 포커스가 대화상자 안의 본문 자리에 남는다(단추가 사라져도 틀로 떨어지지 않음)", async () => {
    answers[REF_EN] = [failed(REF_EN, "queue_full", "대기열이 가득 찼습니다", true), pending(REF_EN), ok(REF_EN, article())];
    const { region } = await preview(/Synthetic Widgets revenue rises/);
    fireEvent.click(within(region).getByRole("button", { name: "본문 보기" }));
    const dialog = await screen.findByRole("dialog");
    const retry = await within(dialog).findByRole("button", { name: "다시 시도" });
    retry.focus();
    fireEvent.click(retry);
    const place = within(dialog).getByRole("status").parentElement as HTMLElement;
    expect(document.activeElement).toBe(place);
    await waitFor(() => expect(within(dialog).getByLabelText("본문")).toBeTruthy());
    expect(document.activeElement).toBe(place);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("한 시간 한도의 잠금 안내는 배너와 같은 분 단위", async () => {
    answers[REF_EN] = [failed(REF_EN, "user_limit", "한 시간에 새로 받을 수 있는 10건을 다 썼습니다 — 약 12분 뒤 다시 누르세요.", true, 720)];
    const { region } = await preview(/Synthetic Widgets revenue rises/);
    fireEvent.click(within(region).getByRole("button", { name: "본문 보기" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/약 12분 동안 다시 시도를 잠가 둡니다/)).toBeTruthy();
    expect(within(dialog).queryByText(/720초/)).toBeNull();
  });

  it("상한까지 받는 중이면 멈추고 '다시 확인'", async () => {
    ARTICLE_POLLING.maxPolls = 4;
    const { region } = await preview(/Synthetic Widgets revenue rises/);
    fireEvent.click(within(region).getByRole("button", { name: "본문 보기" }));
    const dialog = await screen.findByRole("dialog");
    const recheck = await within(dialog).findByRole("button", { name: "다시 확인" });
    expect(articleCalls).toHaveLength(4);
    answers[REF_EN] = [ok(REF_EN, article())];
    fireEvent.click(recheck);
    await waitFor(() => expect(within(dialog).getByLabelText("본문")).toBeTruthy());
    expect(articleCalls).toHaveLength(5);
  });

  it("한국어 글에는 번역 단추가 없고, 영어 글에는 있어 번역 보기·원문 보기로 오간다", async () => {
    answers[REF_KO] = [ok(REF_KO, article({ title: "합성전자 분기 매출 늘어", lang: "ko", paragraphs: ["합성 한국어 문단입니다."] }))];
    answers[REF_EN] = [ok(REF_EN, article())];
    const first = await preview(/합성전자 분기 매출 늘어/);
    fireEvent.click(within(first.region).getByRole("button", { name: "본문 보기" }));
    let dialog = await screen.findByRole("dialog");
    await waitFor(() => within(dialog).getByLabelText("본문"));
    expect(within(dialog).queryByRole("button", { name: "한국어로 번역" })).toBeNull();
    expect(within(dialog).getByLabelText("본문").getAttribute("lang")).toBe("ko");
    cleanup();

    const second = await preview(/Synthetic Widgets revenue rises/);
    fireEvent.click(within(second.region).getByRole("button", { name: "본문 보기" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "한국어로 번역" }));
    const toggle = await within(dialog).findByRole("button", { name: "원문 보기" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(within(dialog).getByLabelText("본문").getAttribute("lang")).toBe("ko");
    expect(within(dialog).getByText("둘째 문단.")).toBeTruthy();
    expect(within(dialog).getByText("합성 위젯 매출 증가")).toBeTruthy();
    expect(translateCalls).toEqual([REF_EN]);
    fireEvent.click(toggle);
    expect(within(dialog).getByRole("button", { name: "번역 보기" }).getAttribute("aria-pressed")).toBe("false");
    expect(within(dialog).getByText("First synthetic paragraph.")).toBeTruthy();
  });

  it("번역 중에도 단추는 포커스를 잃지 않고(aria-disabled — 다시 눌러도 한 번), 끝나면 '원문 보기'로 포커스와 상태 줄 알림", async () => {
    answers[REF_EN] = [ok(REF_EN, article())];
    let finish: (value: unknown) => void = () => {};
    const base = api.apiPost.getMockImplementation();
    api.apiPost.mockImplementation((path: string, body: { ref?: string }) => {
      if (path === endpoints.search.articleTranslate) {
        translateCalls.push(body.ref as string);
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return base?.(path, body);
    });
    const { region } = await preview(/Synthetic Widgets revenue rises/);
    fireEvent.click(within(region).getByRole("button", { name: "본문 보기" }));
    const dialog = await screen.findByRole("dialog");
    const button = await within(dialog).findByRole("button", { name: "한국어로 번역" });
    button.focus();
    fireEvent.click(button);
    const busy = await within(dialog).findByRole("button", { name: "번역 중…" });
    expect(busy).toBe(button);
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect((busy as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement).toBe(busy);
    expect(within(dialog).getByRole("status").textContent).toContain("번역 중입니다");
    fireEvent.click(busy);
    expect(translateCalls).toEqual([REF_EN]);
    finish({ ok: true, titleKo: "합성 위젯 매출 증가", textKo: "첫 문단.\n\n둘째 문단.", alreadyKorean: false, cached: false, truncated: false,
      model: "gemini-3.5-flash", models: ["gemini-3.5-flash"], error: null });
    const toggle = await within(dialog).findByRole("button", { name: "원문 보기" });
    await waitFor(() => expect(document.activeElement).toBe(toggle));
    expect(within(dialog).getByRole("status").textContent).toBe("번역했습니다 — 번역 보기로 바꿨습니다");
    // 번역 보기는 한국어라 한 줄 폭이 72ch, 원문(영어)은 60ch.
    expect((within(dialog).getByLabelText("본문").firstElementChild as HTMLElement).className).toContain("max-w-[72ch]");
    fireEvent.click(toggle);
    expect((within(dialog).getByLabelText("본문").firstElementChild as HTMLElement).className).toContain("max-w-[60ch]");
  });

  it("번역 실패는 상태 줄로 알리고 단추는 '다시 번역'으로 남는다", async () => {
    answers[REF_EN] = [ok(REF_EN, article())];
    const base = api.apiPost.getMockImplementation();
    api.apiPost.mockImplementation((path: string, body: { ref?: string }) => {
      if (path === endpoints.search.articleTranslate) {
        return Promise.resolve({ ok: false, titleKo: null, textKo: null, alreadyKorean: false, cached: false, truncated: false, model: null,
          models: [], error: "오늘 번역 글자 상한을 다 썼습니다" });
      }
      return base?.(path, body);
    });
    const { region } = await preview(/Synthetic Widgets revenue rises/);
    fireEvent.click(within(region).getByRole("button", { name: "본문 보기" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "한국어로 번역" }));
    await waitFor(() => expect(within(dialog).getByRole("status").textContent).toBe("번역하지 못했습니다: 오늘 번역 글자 상한을 다 썼습니다"));
    expect(within(dialog).getByRole("button", { name: "다시 번역" })).toBeTruthy();
  });

  it("한국어 글은 낱말 사이에서만 줄을 바꾸고 한 줄 폭 72ch, 페이지 제목에는 글의 언어", async () => {
    answers[REF_EN] = [ok(REF_EN, article({ title: "Synthetic page title differs", lang: "en" }))];
    answers[REF_KO] = [ok(REF_KO, article({ title: "합성전자 분기 매출 늘어", lang: "ko", paragraphs: ["합성 한국어 문단입니다."] }))];
    const first = await preview(/합성전자 분기 매출 늘어/);
    fireEvent.click(within(first.region).getByRole("button", { name: "본문 보기" }));
    let dialog = await screen.findByRole("dialog");
    const inner = (await within(dialog).findByLabelText("본문")).firstElementChild as HTMLElement;
    expect(inner.className).toContain("break-keep");
    expect(inner.className).toContain("max-w-[72ch]");
    expect(within(dialog).getByRole("heading", { name: "합성전자 분기 매출 늘어" }).getAttribute("lang")).toBe("ko");
    cleanup();

    const second = await preview(/Synthetic Widgets revenue rises/);
    fireEvent.click(within(second.region).getByRole("button", { name: "본문 보기" }));
    dialog = await screen.findByRole("dialog");
    const page = await within(dialog).findByText("Synthetic page title differs");
    expect(page.getAttribute("lang")).toBe("en");
    expect(((await within(dialog).findByLabelText("본문")).firstElementChild as HTMLElement).className).toContain("max-w-[60ch]");
  });

  it("Escape는 팝업만 닫고 포커스가 '본문 보기'로 돌아온다(미리 보기는 남음) — 다음 Escape가 미리 보기를 닫는다", async () => {
    answers[REF_EN] = [ok(REF_EN, article())];
    const { list, region } = await preview(/Synthetic Widgets revenue rises/);
    const button = within(region).getByRole("button", { name: "본문 보기" });
    button.focus();
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => within(dialog).getByLabelText("본문"));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("region", { name: "미리 보기" })).toBe(region);
    await waitFor(() => expect(document.activeElement).toBe(button));
    fireEvent.keyDown(button, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "미리 보기" })).toBeNull();
    expect(document.activeElement).toBe(list);
  });

  it("팝업을 닫으면 다시 묻기를 멈춘다", async () => {
    ARTICLE_POLLING.intervalMs = 20;
    const { region } = await preview(/Synthetic Widgets revenue rises/);
    fireEvent.click(within(region).getByRole("button", { name: "본문 보기" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(articleCalls.length).toBeGreaterThanOrEqual(2));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const seen = articleCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(articleCalls.length).toBeLessThanOrEqual(seen + 1);
    const after = articleCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(articleCalls.length).toBe(after);
  });

  it("수집기에 닿지 못하면 그 글과 다시 시도", async () => {
    answers[REF_EN] = [{ available: false, message: "수집기에서 응답을 받지 못했습니다." }];
    const { region } = await preview(/Synthetic Widgets revenue rises/);
    fireEvent.click(within(region).getByRole("button", { name: "본문 보기" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("수집기에서 응답을 받지 못했습니다.")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "다시 시도" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("긴 글·짧은 글·유료 표시는 아이콘과 글로 알린다", async () => {
    answers[REF_EN] = [ok(REF_EN, article({ truncated: true, totalChars: 52_345, short: true, paywalled: true }))];
    const { region } = await preview(/Synthetic Widgets revenue rises/);
    fireEvent.click(within(region).getByRole("button", { name: "본문 보기" }));
    const dialog = await screen.findByRole("dialog");
    const flags = await within(dialog).findByRole("list", { name: "본문 표지" });
    expect(within(flags).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "글이 길어 앞 40,000자만 보입니다(전체 52,345자).",
      "추린 글이 짧습니다 — 유료·로그인 글이거나 본문이 그림·영상일 수 있습니다.",
      "유료 글 표시가 있어 공개된 앞부분만일 수 있습니다.",
    ]);
    expect(flags.querySelectorAll("svg")).toHaveLength(3);
  });
});
