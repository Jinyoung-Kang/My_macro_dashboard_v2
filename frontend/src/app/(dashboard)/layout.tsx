"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Shell } from "@/components/shell/Shell";
import { ToastProvider } from "@/components/ui/Toast";
import { useApi } from "@/hooks/useApi";
import { apiBase } from "@/lib/api";
import { RefreshProvider, useRefreshSignal } from "@/hooks/useRefreshSignal";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { SessionResponse } from "@/lib/types";
import { ALERTS_READ_EVENT, titleWithUnread } from "@/lib/alerts";
import { isNoLogin } from "@/lib/access";
import { documentTitle } from "@/lib/nav";

/**
 * 대시보드 공통 레이아웃 — 셸(왼쪽 내비·상단바 검색·알림 벨·하단 탭) + 거래소 시계.
 *
 * 세션이 없으면 로그인 화면으로 보냅니다. 구버전의 "비밀번호 잠금"과 같은
 * 역할이며, 실제 접근 차단은 백엔드가 합니다(프런트 검사는 UX용입니다).
 *
 * 로컬 Docker 실행은 로그인 없이 엽니다(ADR 0016). 세션 응답의 noLogin이 true면 백엔드가 localhost
 * 요청을 첫 운영자 계정으로 풀어 authenticated를 주므로, 로그인 화면으로 보내지 않습니다 — 화면의
 * 401(sessionLost)도 로그인으로 보내지 않고 세션을 한 번 다시 확인합니다. 운영자 계정이 아직 없으면
 * (ownerMissing) 만드는 방법을 안내하고 5초마다 다시 확인합니다. localhost가 아닌 주소로 열어 운영자로
 * 풀리지 않았으면 지금처럼 로그인 화면으로 보냅니다. noLogin이 없거나 false인 응답(AWS 웹 데모·QA 스택·
 * 이전 백엔드)은 지금과 같습니다.
 */
export default function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // 레이아웃 자신도 useApi를 쓰므로 Provider 안쪽에 있어야 합니다.
  // (수동 새로고침이 셸의 읽기 모드 표시까지 갱신합니다.)
  return (
    <RefreshProvider>
      <DashboardShell>{children}</DashboardShell>
    </RefreshProvider>
  );
}

/**
 * 브라우저 탭 제목을 현재 메뉴 이름으로 바꿉니다(lib/nav documentTitle — "순유동성 · 매크로 대시보드").
 *
 * <p>모든 화면이 클라이언트 컴포넌트라 Next의 정적 metadata를 페이지마다 둘 수
 * 없습니다. 그대로 두면 탭 12개가 전부 같은 제목이라, 매크로·레이더·13F를 함께
 * 띄워 두고 비교할 때 어느 탭이 무엇인지 구분할 수 없습니다.
 */
function useDocumentTitle(pathname: string, unread: number | null) {
  useEffect(() => {
    // 읽지 않은 알림이 있으면 앞에 수를 붙입니다(화면 알림함만이라 알아차리는 길이 이것뿐입니다).
    document.title = titleWithUnread(documentTitle(pathname), unread);
  }, [pathname, unread]);
}

/** 세션 확인이 이 시간 안에 끝나지 않으면 "응답 없음"으로 보여 줍니다. */
const SESSION_TIMEOUT_MS = 10_000;
/** 백엔드에 닿지 못했을 때 자동으로 다시 확인하는 간격. 백엔드가 뜨면 스스로 풀립니다. */
const SESSION_RETRY_MS = 5_000;

function DashboardShell({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const router = useRouter();
  const pathname = usePathname();
  // 읽지 않은 알림 수 — 기존 자동 갱신 주기(5분). 알림 사건이 5분 평가에서 생기므로 더 빠를 이유가 없습니다.
  const alerts = useApi<{ unread: number }>(endpoints.alerts.unreadCount, 300_000, { followRefresh: false });
  // 모르면(읽는 중·실패) null — 알림 벨이 "0건"을 지어내지 않게 합니다(탭 제목은 0과 같게 접두사 없음).
  const unread = alerts.data ? alerts.data.unread : null;
  useDocumentTitle(pathname, unread);
  // 알림함에서 읽음 처리하면 바로 다시 읽습니다(5분을 기다리지 않음, QA-051).
  const reloadUnread = alerts.reload;
  useEffect(() => {
    const onRead = () => void reloadUnread();
    window.addEventListener(ALERTS_READ_EVENT, onRead);
    return () => window.removeEventListener(ALERTS_READ_EVENT, onRead);
  }, [reloadUnread]);
  // 수동 새로고침에는 반응하지 않습니다(followRefresh: false). 반응하면 새로고침마다
  // 아래의 "세션을 확인하는 중…"이 떠 화면 전체가 다시 그려지고 화면 상태가 초기화됐습니다.
  const session = useApi<SessionResponse>(endpoints.auth.session, 0, {
    timeoutMs: SESSION_TIMEOUT_MS,
    followRefresh: false,
  });
  const { data, loading, unauthorized, error, reload } = session;
  // 세션은 처음 한 번만 확인합니다. 그 뒤 만료(12시간, 다른 탭 로그아웃)는 화면의 어떤 요청이든
  // 401을 받았을 때 올라오는 이 신호로 압니다.
  const { sessionLost, unauthorizedCount } = useRefreshSignal();

  const authenticated = data?.authenticated ?? false;
  const noLogin = isNoLogin(data);
  // 로그인 없이 열려는데 운영자 계정이 없음 — 로그인 화면도 쓸 수 없으니 계정을 만드는 방법을 안내합니다.
  const waitingForOwner = noLogin && !authenticated && data?.ownerMissing === true;

  useEffect(() => {
    // 세션 확인이 끝나기 전에는 보내지 않습니다. 알림 벨의 읽지 않은 수 같은 다른 요청의 401이 먼저 오면
    // 로그인 없이 열리는 로컬인지 모르는 채로 로그인 화면에 갔습니다(운영자 계정이 없을 때).
    if (loading) return;
    const toLogin = noLogin
      ? !authenticated && !waitingForOwner   // 로컬 주소가 아니라 운영자로 풀리지 않은 요청
      : sessionLost || unauthorized || (data && !authenticated);
    if (toLogin) router.replace("/login");
  }, [noLogin, waitingForOwner, sessionLost, loading, unauthorized, data, authenticated, router]);

  // 로그인 없이 연 화면에서 401이 오면 로그인으로 보내지 않고 세션을 다시 확인합니다. 백엔드가 그 사이
  // 로그인 모드로 바뀌었으면(noLogin: false) 위 effect가 지금처럼 로그인 화면으로 보냅니다. 401마다 확인합니다 —
  // sessionLost는 한 번 켜지면 내려가지 않아, 그것만 보면 운영자 계정을 기다리던 때의 401 뒤로는 다시 확인하지 않았습니다.
  useEffect(() => {
    if (noLogin && unauthorizedCount > 0) void reload();
  }, [noLogin, unauthorizedCount, reload]);

  // 백엔드에 닿지 못한 이유를 기억해 둡니다. 다시 확인하는 동안(loading) 안내 화면이
  // "세션을 확인하는 중…"으로 깜빡이지 않게, 성공하거나 401을 받을 때만 지웁니다.
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    if (error) setFailure(error);
    else if (data || unauthorized) setFailure(null);
  }, [error, data, unauthorized]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => void reload(), SESSION_RETRY_MS);
    return () => clearTimeout(timer);
  }, [error, reload]);

  // 운영자 계정을 기다리는 동안에도 같은 간격으로 다시 확인합니다 — .env를 고치고 make up 하면 새로고침 없이
  // 넘어갑니다. 응답은 매번 같은 "계정 없음"이라 응답에 맞춰 다음 확인을 걸면 한 번으로 멈출 수 있어 주기로 겁니다.
  // 숨은 탭에서는 묻지 않습니다(열어 둔 탭마다 백엔드를 5초마다 깨우지 않게).
  useEffect(() => {
    if (!waitingForOwner) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void reload();
    }, SESSION_RETRY_MS);
    return () => clearInterval(timer);
  }, [waitingForOwner, reload]);

  // 예전에는 여기가 `loading || !authenticated`뿐이었습니다. 백엔드가 꺼져 있으면
  // 요청이 실패해 loading=false·data=null이 되는데, 로그인으로 보내는 조건(401 또는
  // authenticated=false 응답)에도 걸리지 않아 "세션을 확인하는 중…"에 영원히 멈췄습니다.
  if (failure && !authenticated) {
    return <BackendUnavailable reason={failure} retrying={loading} onRetry={() => void reload()} />;
  }

  if (waitingForOwner) {
    return <OwnerMissing retrying={loading} onRetry={() => void reload()} />;
  }

  // 이미 로그인이 확인됐으면, 다시 확인하는 동안(loading)에도 화면을 그대로 둡니다.
  if (!authenticated) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-muted">
        세션을 확인하는 중…
      </main>
    );
  }

  return (
    // 화면들이 세션을 다시 읽지 않고 사용자(데모 열람 여부 등)를 알 수 있게 내려 줍니다.
    <SessionUserProvider user={data?.user}>
      {/* 짧은 안내(토스트)는 셸 안 어디서든 띄웁니다. 화면만 그리는 테스트에서는 Provider가 없어 아무 일도 하지 않습니다. */}
      <ToastProvider>
        {/* 읽기 모드는 세션 응답에 함께 옵니다. 예전에는 이 한 줄 때문에 페이지를 열 때마다
            무거운 /api/status(수집기 상태 + DB 집계)를 불렀습니다. 셸은 MarketClock을 본문 맨 위에 그립니다. */}
        <Shell readMode={data?.readMode} user={data?.user} unread={unread}>
          {children}
        </Shell>
      </ToastProvider>
    </SessionUserProvider>
  );
}

/**
 * 백엔드 API에 닿지 못했을 때의 안내.
 *
 * <p>화면(3000)은 떠 있는데 API(8080)가 없는 상태입니다. 흔한 원인은 백엔드 컨테이너가
 * 기동에 실패한 것(예: 포트 충돌)이라, 사용자가 바로 확인할 명령을 적어 둡니다.
 * 5초마다 스스로 다시 확인하므로 백엔드가 뜨면 새로고침 없이 넘어갑니다.
 */
function BackendUnavailable({
  reason,
  retrying,
  onRetry,
}: {
  reason: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-lg rounded-xl border border-warn/40 bg-surface p-6 text-sm">
        <h1 className="text-base font-bold text-bright">⚠️ 백엔드 API에 연결하지 못했습니다</h1>
        <p className="mt-2 text-warn">{reason}</p>
        <p className="mt-4 text-muted">
          화면은 떠 있지만 데이터를 주는 백엔드가 응답하지 않습니다. 터미널에서 확인하세요.
        </p>
        <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-canvas px-3 py-2 text-xs text-body">
{`make doctor          # 어디가 막혔는지 한 번에
docker compose ps    # backend가 running인지
make logs S=backend  # 기동 실패 원인`}
        </pre>
        <p className="mt-3 text-xs text-muted">
          화면이 찾는 주소: <code className="text-body">{apiBase() || "같은 출처 /api"}</code> ·{" "}
          {retrying ? "다시 확인하는 중…" : `${SESSION_RETRY_MS / 1000}초마다 자동으로 다시 확인합니다`}
        </p>
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="mt-4 rounded-md border border-accent/60 bg-accent/15 px-3 py-1.5 text-xs font-semibold text-accent transition hover:bg-accent/25 disabled:opacity-50"
        >
          지금 다시 확인
        </button>
      </div>
    </main>
  );
}

/**
 * 로그인 없이 여는 로컬 실행(ADR 0016)인데 운영자 계정이 아직 없을 때의 안내.
 *
 * <p>로그인 없이 열면 백엔드가 첫 운영자 계정으로 화면을 엽니다. 그 계정은 백엔드가 처음 기동할 때 .env의
 * OWNER_EMAIL·APP_PASSWORD로 만들므로, 둘이 비어 있으면 열 계정이 없습니다. 로그인 화면으로 보내도
 * 들어갈 계정이 없어 여기서 안내하고, 5초마다 다시 확인해 계정이 생기면 새로고침 없이 넘어갑니다.
 */
function OwnerMissing({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-lg rounded-xl border border-warn/40 bg-surface p-6 text-sm">
        <h1 className="text-base font-bold text-bright">⚠️ 운영자 계정이 아직 없습니다</h1>
        <p className="mt-2 text-warn">
          로컬 실행은 로그인 없이 운영자 계정으로 열립니다. .env에 OWNER_EMAIL·APP_PASSWORD를 넣고 make up 하세요.
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted">
          <li>.env의 OWNER_EMAIL·APP_PASSWORD가 비어 있음 — 계정이 하나도 없을 때만 그 값으로 운영자를 만듭니다</li>
          <li>스키마가 아직 적용되지 않음(docker compose up을 직접 쓴 경우) — make migrate 또는 make doctor</li>
          <li>복원한 백업에 운영자 없이 회원만 있음 — 계정이 하나라도 있으면 새로 만들지 않으니 운영자가 있는 백업인지 확인하세요</li>
        </ul>
        <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-canvas px-3 py-2 text-xs text-body">
{`make up              # .env를 고친 뒤 — 백엔드가 기동하며 운영자 계정을 만듦
make logs S=backend  # 그래도 이 화면이면 원인 확인`}
        </pre>
        <p className="mt-3 text-xs text-muted">
          {retrying ? "다시 확인하는 중…" : `${SESSION_RETRY_MS / 1000}초마다 자동으로 다시 확인합니다`}
        </p>
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="mt-4 rounded-md border border-accent/60 bg-accent/15 px-3 py-1.5 text-xs font-semibold text-accent transition hover:bg-accent/25 disabled:opacity-50"
        >
          지금 다시 확인
        </button>
      </div>
    </main>
  );
}
