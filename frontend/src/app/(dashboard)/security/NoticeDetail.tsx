"use client";

import { InspectorSubheading, PropertyList, Skeleton } from "@/components/patterns";
import { Callout, ErrorState, LINK_CLASSES } from "@/components/ui";
import { ExternalLinkIcon } from "@/components/ui/icons";
import { firstLoadPending, useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { EMPTY, formatKst } from "@/lib/format";
import {
  NO_INVENTORY_NOTE,
  detailStatusLabel,
  layoutLabel,
  matchInstalledText,
  reasonDescription,
  reasonLabel,
  reasonsText,
  safeExternalUrl,
  verdictView,
} from "@/lib/security";
import type { SecurityMatch, SecurityNoticeResponse, SecurityNoticeRow } from "@/lib/types";
import { VerdictText } from "./VerdictText";

const SUBHEADING = "mb-1 text-caption font-semibold text-text-2";

/**
 * 공지 검사 칸 — 공지 한 건(GET /api/security/notices/{번호})을 열 때 읽습니다. 공지 판정·사유(한국어 글과 설명)·제품·게시일·표 틀·상세 받기 상태, 표 밖 ※ 조건
 * 문장(안내 상자), 표 행마다 영향·해결 버전 원문과 그 행의 판정·사유·설치 버전, 행에 매이지 않는 근거, 원문 링크(새 창). 설치 버전은 운영자 화면에만 보입니다.
 */
export function NoticeDetail({ nttId }: { nttId: string }) {
  const read = useApi<SecurityNoticeResponse>(endpoints.security.notice(nttId), 0);
  if (firstLoadPending(read)) return <Skeleton lines={6} label="공지를 불러오는 중" />;
  if (read.error) return <ErrorState message={read.error} onRetry={read.reload} />;
  const data = read.data;
  if (!data) return null;
  const { notice, rows, generalMatches } = data;
  const verdict = verdictView(notice.verdict);
  const url = safeExternalUrl(notice.url);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PropertyList
        dense
        items={[
          { label: "판정", value: <VerdictText code={notice.verdict} />, note: verdict.description },
          { label: "사유", value: reasonsText(notice.reasons), note: <ReasonNotes codes={notice.reasons} /> },
          {
            label: "제품",
            value:
              notice.products.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {notice.products.map((product) => (
                    <li key={product.aliasId} className="flex flex-wrap items-center gap-x-2">
                      <span>{product.label}</span>
                      <VerdictText code={product.status} />
                      {product.reasons.length > 0 ? <span className="text-caption text-text-3">{reasonsText(product.reasons)}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null,
            emptyReason: "이 스택의 제품 이름이 나오지 않음",
          },
          { label: "게시일", value: notice.postedOn },
          { label: "글 번호", value: String(notice.nttId), mono: true },
          { label: "표 틀", value: layoutLabel(notice.layout) },
          {
            label: "상세",
            value: `${detailStatusLabel(notice.detailStatus)}${notice.detailFetchedAt ? ` · ${formatKst(notice.detailFetchedAt)}` : ""}`,
            note: notice.detailError,
          },
          { label: "CVE", value: typeof notice.cveCount === "number" ? `${notice.cveCount}건` : null },
        ]}
      />

      {notice.conditionNotes.length > 0 ? (
        <Callout tone="warn" title="표 밖 조건 문장(※)">
          <ul className="mt-1 flex flex-col gap-1">
            {notice.conditionNotes.map((note, index) => (
              <li key={index} className="wrap-anywhere">
                {note}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
      {!data.inventory ? (
        <Callout tone="warn">{NO_INVENTORY_NOTE} 그때까지 제품이 맞는 공지는 확인 필요입니다.</Callout>
      ) : null}

      {rows.length > 0 ? (
        <section className="min-w-0">
          <InspectorSubheading fallback="h4" className={SUBHEADING}>
            표 행 {rows.length}개
          </InspectorSubheading>
          <ol className="flex flex-col">
            {rows.map((row) => (
              <NoticeRowItem key={row.index} row={row} />
            ))}
          </ol>
        </section>
      ) : null}

      {generalMatches.length > 0 ? (
        <section className="min-w-0">
          <InspectorSubheading fallback="h4" className={SUBHEADING}>
            행에 매이지 않는 근거
          </InspectorSubheading>
          <ul className="flex flex-col">
            {generalMatches.map((match, index) => (
              <li key={`${match.aliasId}-${index}`} className="border-b border-border-subtle py-1.5 text-sm last:border-0">
                <MatchLine match={match} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {url ? (
        <p>
          <a href={url} target="_blank" rel="noopener noreferrer" className={`${LINK_CLASSES} gap-1`}>
            보호나라 원문 열기(새 창)
            <ExternalLinkIcon size={14} />
          </a>
        </p>
      ) : null}
    </div>
  );
}

/** 사유마다 설명 한 줄(12px 보조 글). 사유가 없으면 아무것도 그리지 않습니다. */
function ReasonNotes({ codes }: { codes: readonly string[] }) {
  const lines = codes.map((code) => ({ code, text: reasonDescription(code) })).filter((line) => line.text);
  if (lines.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5">
      {lines.map((line) => (
        <li key={line.code}>
          {reasonLabel(line.code)}: {line.text}
        </li>
      ))}
    </ul>
  );
}

/** 표 행 하나 — 'CVE · 제품' 머리와 영향·해결 버전(칸 원문), 그 행의 판정·사유, 설치 버전(근거 줄). */
function NoticeRowItem({ row }: { row: SecurityNoticeRow }) {
  const installed = row.matches.map(matchInstalledText).filter((text): text is string => text !== null);
  return (
    <li className="border-b border-border-subtle py-2 last:border-0">
      <p className="mb-1 break-keep wrap-anywhere text-sm font-medium text-text">
        <span className="font-mono">{row.cve ?? EMPTY}</span> · {row.product ?? EMPTY}
      </p>
      <PropertyList
        dense
        items={[
          { label: "영향받는 버전", value: row.affected },
          { label: "해결 버전", value: row.fixed },
          { label: "이 행의 판정", value: <VerdictText code={row.status} />, note: reasonsText(row.reasons) },
          {
            label: "설치 버전",
            value: installed.length > 0 ? installed.join(" / ") : null,
            emptyReason: row.aliases.length === 0 ? "이 스택이 쓰지 않는 제품" : "행에 맞는 구성 요소 없음",
          },
        ]}
      />
    </li>
  );
}

/** 행에 매이지 않는 근거 한 줄 — '제품 · 판정 · 사유 · 설치 버전'. */
function MatchLine({ match }: { match: SecurityMatch }) {
  const installed = matchInstalledText(match);
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 break-keep wrap-anywhere">
      <span className="text-text">{match.label ?? match.aliasId}</span>
      <VerdictText code={match.status} />
      {match.reason ? <span className="text-text-2">{reasonLabel(match.reason)}</span> : null}
      {installed ? <span className="text-text-2">설치 {installed}</span> : null}
    </span>
  );
}
