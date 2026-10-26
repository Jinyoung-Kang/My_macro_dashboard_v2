"use client";

import { useRefreshSignal } from "@/hooks/useRefreshSignal";
import { isOwner } from "@/lib/access";
import type { SessionUser } from "@/lib/types";

/**
 * 운영자의 데이터 수동 새로고침 — 수집 요청 → 끝날 때까지 대기 → 화면 전체 갱신까지 한 번에(useRefreshSignal).
 *
 * 수집을 일으키므로 운영자만 단추를 봅니다(백엔드도 403). 결과 안내 문구는 단추 아래에 남깁니다 — 알림(토스트)은 몇 초 뒤
 * 사라지지만 이 문구는 다음 새로고침까지 그대로라, 무엇이 갱신됐는지 나중에도 읽을 수 있습니다.
 */
export function RefreshButton({ user }: { user?: SessionUser }) {
  const { requestRefresh, collecting, message } = useRefreshSignal();
  return (
    <div className="flex flex-col gap-2">
      {isOwner(user) && (
        <button
          type="button"
          onClick={() => void requestRefresh()}
          disabled={collecting}
          className="inline-flex h-11 items-center justify-center rounded-lg bg-accent px-3 text-sm font-semibold text-accent-fg hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50 lg:h-9"
        >
          {collecting ? "수집 중… 끝나면 자동 갱신" : "데이터 수동 새로고침 🚀"}
        </button>
      )}
      {message && (
        <p role="status" className="text-xs leading-5 text-text-3">
          {message}
        </p>
      )}
    </div>
  );
}
