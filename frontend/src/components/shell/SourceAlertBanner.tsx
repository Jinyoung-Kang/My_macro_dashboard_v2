"use client";

import Link from "next/link";
import { Banner, buttonClasses } from "@/components/ui";
import { XIcon } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { useDismissed } from "@/hooks/useDismissed";
import { isOwner } from "@/lib/access";
import { endpoints } from "@/lib/endpoints";
import { INFO_DISMISS_KEY, type InfoSourcesResponse, bannerText, unseenIncidents } from "@/lib/info";
import type { SessionUser } from "@/lib/types";

/**
 * 수집 출처 끊김 안내 띠(ADR 0035 결정 7) — 운영자에게만, 모든 화면의 본문 위에 뜹니다. 차단 통과 수집 계층의 출처가 차단·형식 바뀜·받지 못함·
 * 오래 못 받음이면 출처 이름과 종류를 한 줄로 보이고 '정보 수집 > 출처 상태'로 잇습니다. 같은 사건은 텔레그램으로도 한 통 갑니다(백엔드).
 *
 * 닫으면 그 사건들은 이 브라우저에서 다시 보이지 않고, 새 사건이 생기면 다시 뜹니다. 운영자가 아니면 요청하지 않습니다(null 경로).
 */
export function SourceAlertBanner({ user }: { user?: SessionUser }) {
  const owner = isOwner(user);
  const { data } = useApi<InfoSourcesResponse>(owner ? endpoints.info.sources : null, 300_000);
  const [dismissed, dismiss] = useDismissed(INFO_DISMISS_KEY);
  const unseen = unseenIncidents(data?.incidents ?? [], dismissed);
  if (!owner || unseen.length === 0) return null;
  return (
    <div className="mb-4" data-testid="source-alert-banner">
      <Banner tone="warn">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="min-w-0">
            {bannerText(unseen)}. 그 출처만 멈추고 직전 저장본을 유지합니다.{" "}
            <Link href="/paper/info?tab=sources" className="font-semibold underline underline-offset-2">
              출처 상태 보기
            </Link>
          </p>
          <button
            type="button"
            onClick={() => dismiss(unseen.map((incident) => incident.key))}
            className={buttonClasses("ghost", "sm")}
            aria-label="수집 끊김 안내 닫기"
          >
            <XIcon size={14} />
            닫기
          </button>
        </div>
      </Banner>
    </div>
  );
}
