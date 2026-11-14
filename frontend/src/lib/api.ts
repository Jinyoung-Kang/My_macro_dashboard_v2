/**
 * src/lib/api.ts
 * 백엔드 API 클라이언트.
 *
 * 인증은 httpOnly 쿠키로 처리되므로 credentials: "include"가 필수입니다.
 * (토큰을 localStorage에 두지 않습니다 — XSS로 새어 나갈 수 있습니다.)
 */

import { endpoints } from "./endpoints.ts";
import { createSharedFetcher } from "./sharedRequest.ts";
import type { SessionResponse, SessionUser } from "./types.ts";

/** 빌드 시점에 명시한 전체 주소(리버스 프록시 등). 비어 있으면 실행 시점에 정합니다. */
const BUILD_TIME_BASE = process.env.NEXT_PUBLIC_API_BASE || "";
const BACKEND_PORT = process.env.NEXT_PUBLIC_BACKEND_PORT || "8080";

/**
 * 백엔드 주소.
 *
 * 예전에는 빌드 시점의 `http://localhost:8080`이 번들에 박혔습니다. 휴대폰에서
 * `http://192.168.x.x:3000`을 열면 **휴대폰 자신의** localhost:8080을 찾아 실패했고,
 * 문서대로 LAN IP를 박아 다시 빌드하면 이번엔 맥의 localhost:3000에서 쿠키(SameSite=Strict)가
 * 다른 사이트라 보내지지 않아 로그인이 깨졌습니다 — 둘 중 하나만 됐습니다.
 *
 * 화면을 연 주소(hostname)에 백엔드 포트만 붙이면 어느 기기에서 열어도 같은 호스트의
 * 백엔드를 부르고, 쿠키도 같은 사이트가 됩니다. 전체 주소를 꼭 고정해야 하면(프록시)
 * NEXT_PUBLIC_API_BASE로 덮어씁니다.
 *
 * `NEXT_PUBLIC_API_BASE=/`는 **같은 출처**입니다(빈 문자열 → `/api/...` 상대 경로). 프록시가 화면과
 * `/api`를 한 주소로 묶을 때(AWS 배포, ADR 0012) 씁니다 — 이미지에 공개 주소를 박지 않아 같은 이미지가
 * 공개 주소와 관리자 터널(localhost) 양쪽에서 돕니다.
 */
export function apiBase(): string {
  if (BUILD_TIME_BASE === "/") return "";
  if (BUILD_TIME_BASE) return BUILD_TIME_BASE;
  if (typeof window === "undefined") return `http://localhost:${BACKEND_PORT}`;
  return `${window.location.protocol}//${window.location.hostname}:${BACKEND_PORT}`;
}

/** @deprecated 실행 시점 주소는 apiBase()를 쓰세요. 남아 있는 안내 문구용. */
export const API_BASE = apiBase();

export class ApiError extends Error {
  /**
   * @param code 서버 오류 본문의 `error` 칸(있으면 — 예: 실제 매매 켜기의 `password-invalid`). 화면이 코드별 문구를 고를 때 씁니다.
   */
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class UnauthorizedError extends ApiError {
  /** @param message 서버가 준 문구(로그인 실패 사유 등). 없으면 세션 만료 문구 */
  constructor(message = "로그인이 필요합니다.") {
    super(message, 401);
    this.name = "UnauthorizedError";
  }
}

/**
 * 백엔드에 닿지 못했습니다(응답 자체가 없음). HTTP 상태가 없으므로 status는 0입니다.
 *
 * 브라우저는 연결 거부·주소 오류·CORS 차단을 모두 "Failed to fetch"(Safari는
 * "Load failed") 한 줄로만 알려 줍니다. 그 문구로는 무엇을 확인해야 할지 알 수
 * 없어서, 어느 주소에 닿지 못했는지를 함께 적습니다.
 */
export class NetworkError extends ApiError {
  /**
   * 시간 한도를 넘겨 끊은 요청인가 — 서버가 요청을 받았을 수 있습니다(처리 여부를 모름). 연결하지 못한 경우는 false입니다.
   * 쓰기 요청의 화면이 '처리됐을 수 있으니 상태를 확인하세요'를 가를 때 씁니다(QA-345).
   */
  readonly timedOut: boolean;

  constructor(message: string, timedOut = false) {
    super(message, 0);
    this.name = "NetworkError";
    this.timedOut = timedOut;
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = 0,
): Promise<T> {
  // 시간 제한은 호출자의 signal과 별개의 컨트롤러로 겁니다. 호출자가 취소한 것
  // (화면 이동 등 — 조용히 무시해야 함)과 시간 초과(오류로 보여야 함)를 구분하려고요.
  const controller = new AbortController();
  const external = init.signal;
  const forwardAbort = () => controller.abort();
  if (external?.aborted) {
    controller.abort();
  } else {
    external?.addEventListener("abort", forwardAbort, { once: true });
  }
  let timedOut = false;
  const timer = timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
    : null;

  const base = apiBase();
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      signal: controller.signal,
      credentials: "include",
      headers: {
        // 본문이 있을 때만 Content-Type을 보냅니다. GET에도 붙이면 '단순 요청'이 아니게 되어
        // 브라우저가 URL마다 OPTIONS(preflight)를 먼저 보내, 필터 조합마다 요청이 두 배였습니다.
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    if (timedOut) {
      throw new NetworkError(
        `백엔드가 ${Math.round(timeoutMs / 1000)}초 안에 응답하지 않았습니다 (${base})`,
        true,
      );
    }
    if (external?.aborted) {
      throw error; // 호출자가 취소 — 그대로 올려 호출자가 무시하게 둡니다
    }
    throw new NetworkError(`백엔드 API(${base})에 연결하지 못했습니다`);
  } finally {
    if (timer !== null) clearTimeout(timer);
    external?.removeEventListener("abort", forwardAbort);
  }

  if (response.status === 401) {
    // 401도 서버 문구를 씁니다 — 로그인 실패("이메일 또는 비밀번호가 올바르지 않습니다")와 세션 만료가 같은 401입니다(QA-044).
    throw new UnauthorizedError((await messageOf(response)) ?? undefined);
  }

  if (!response.ok) {
    const body = await errorBodyOf(response);
    throw new ApiError(body.message ?? `요청 실패 (HTTP ${response.status})`, response.status, body.code);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/** 오류 응답 본문의 message. 본문이 JSON이 아니거나 없으면 null. */
async function messageOf(response: Response): Promise<string | null> {
  return (await errorBodyOf(response)).message;
}

/** 오류 본문의 `message`·`error`(코드). 본문이 JSON이 아니거나 칸이 비면 null. */
async function errorBodyOf(response: Response): Promise<{ message: string | null; code: string | null }> {
  try {
    const body = await response.json();
    const message = typeof body?.message === "string" && body.message ? body.message : null;
    const code = typeof body?.error === "string" && body.error ? body.error : null;
    return { message, code };
  } catch {
    return { message: null, code: null };
  }
}

/**
 * @param timeoutMs 0이면 제한 없음. 화면 전체를 막는 요청(세션 확인)에만 겁니다 —
 *                  외부 API를 부르는 진단 요청은 수십 초가 정상일 수 있습니다.
 */
export function apiGet<T>(path: string, signal?: AbortSignal, timeoutMs = 0): Promise<T> {
  return request<T>(path, { method: "GET", signal }, timeoutMs);
}

const sharedGet = createSharedFetcher<unknown>((key) => {
  const separator = key.indexOf("|");
  return apiGet(key.slice(separator + 1), undefined, Number(key.slice(0, separator)));
});

/**
 * 진행 중인 같은 GET이 있으면 그 결과를 함께 씁니다(lib/sharedRequest 설명 참고).
 *
 * 취소 신호를 받지 않습니다 — 요청은 다른 쪽을 위해 끝까지 갑니다. 받는 쪽이 자기
 * 취소 여부를 보고 결과를 버리세요(useApi가 그렇게 합니다).
 */
export function apiGetShared<T>(path: string, timeoutMs = 0): Promise<T> {
  return sharedGet(`${timeoutMs}|${path}`) as Promise<T>;
}

export function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

/**
 * @param options.timeoutMs 주면 그 시간 뒤 요청을 끊고 NetworkError(timedOut)로 끝냅니다. 주지 않으면 제한 없음(예전과 같음).
 *                          응답이 오지 않을 때 단추가 '처리 중'으로 잠기면 안 되는 쓰기(실제 매매 끄기·켜기류 — QA-345)에만 겁니다.
 *                          끊긴 요청을 서버가 이미 처리했을 수 있으므로, 부르는 쪽은 상태를 다시 읽어야 합니다.
 */
export function apiPost<T>(path: string, body?: unknown, options?: { timeoutMs?: number }): Promise<T> {
  return request<T>(
    path,
    {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    options?.timeoutMs ?? 0,
  );
}

/**
 * 일부 칸만 고치는 쓰기(정보 검색 관심 대상의 별칭·알림 — PATCH /api/search/watch/{id}). 본문은 JSON, 시간 한도는 없습니다(apiPost와 같음).
 * 화면과 백엔드 포트가 다르면 브라우저가 OPTIONS를 먼저 보내므로 백엔드 CORS 허용 메서드에 PATCH가 있어야 합니다.
 */
export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

// ---------------------------------------------------------------- 인증
export const auth = {
  login: (email: string, password: string) =>
    apiPost<{ ok: boolean; user?: SessionUser }>(endpoints.auth.login, { email, password }),
  logout: () => apiPost<{ ok: boolean }>(endpoints.auth.logout),
  logoutOthers: () => apiPost<{ ok: boolean; revoked: number }>(endpoints.auth.logoutAll),
  changePassword: (current: string, next: string) =>
    apiPost<{ ok: boolean; message: string }>(endpoints.auth.password, { current, next }),
  session: () => apiGet<SessionResponse>(endpoints.auth.session),
  signup: (email: string, password: string, agreed: boolean) =>
    apiPost<{ ok: boolean; message: string }>(endpoints.auth.signup, { email, password, agreed }),
  verify: (token: string) => apiPost<{ ok: boolean; message: string }>(endpoints.auth.verify, { token }),
  requestReset: (email: string) => apiPost<{ ok: boolean; message: string }>(endpoints.auth.resetRequest, { email }),
  confirmReset: (token: string, password: string) =>
    apiPost<{ ok: boolean; message: string }>(endpoints.auth.resetConfirm, { token, password }),
  deleteAccount: (password: string) =>
    apiPost<{ ok: boolean; message: string }>(endpoints.auth.deleteAccount, { password }),
};
