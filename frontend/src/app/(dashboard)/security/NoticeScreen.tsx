"use client";

import Link from "next/link";
import { useState } from "react";
import { DataTable, EntityHeader, FilterList, Skeleton, type Column } from "@/components/patterns";
import { Callout, ErrorState, LINK_CLASSES, PageHeader, Panel, Tag, buttonClasses } from "@/components/ui";
import { ExternalLinkIcon, ShieldIcon, StatusText } from "@/components/ui/icons";
import { firstLoadPending, useApi } from "@/hooks/useApi";
import { useEntityCrumb } from "@/hooks/useEntityCrumb";
import { securityNoticeHref } from "@/lib/detail";
import { endpoints } from "@/lib/endpoints";
import { EMPTY, formatKst } from "@/lib/format";
import {
  NO_INVENTORY_NOTE,
  SECURITY_LIMIT_NOTE,
  detailStatusLabel,
  environmentLines,
  evidenceReasonText,
  layoutLabel,
  parseNttParam,
  reasonDescription,
  reasonLabel,
  reasonsText,
  rowScopeItems,
  safeExternalUrl,
  sectionLabel,
  stackRows,
  trackerName,
  trackerStatusView,
  trackerUrl,
  verdictView,
  type EvidenceLine,
  type NoticeRowScope,
} from "@/lib/security";
import type { SecurityMatch, SecurityNoticeResponse, SecurityNoticeRow, SecurityTrackerCve } from "@/lib/types";
import { Fold } from "./Fold";
import { VerdictText } from "./VerdictText";

/** 대상 머리의 종류 — 이름 옆 '보안 공지' 태그와 방패 아이콘(장식). */
const KIND = { label: "보안 공지", icon: ShieldIcon };

/** 목록 화면 주소. */
const LIST_HREF = "/security";

/** 공지 표가 길면(Oracle 정기 공지 등 수백 행) 이 높이에서 세로로 스크롤합니다 — 머리 줄은 위에 붙음. */
const NOTICE_TABLE_MAX_HEIGHT = 480;

/**
 * 보안 공지 상세(/security/<번호> — ADR 0046, 운영자 전용·읽기만). 목록의 요약 칸 '자세히 보기'가 오는 곳이고, 기존 API `GET /api/security/notices/{번호}` 하나만
 * 읽습니다(수집을 일으키지 않음). 작업대 대상 문법(ADR 0042 — 대상 머리 + 패널):
 *
 * - 머리: 제목(h1)·'보안 공지' 종류 태그·글 번호·게시일·표 틀·상세 받기 상태·판정(아이콘 + 글)·사유, 오른쪽 '목록으로'·'원문 열기(새 창)'.
 * - ① 이 환경 판정: 같은 제품·구역·판정의 근거를 한 줄로 묶은 표(판정·제품·구역·설치 판·해결 판·사유/근거) — 해당 → 확인 필요가 먼저 보이고, 패치됨·무관은
 *   건수를 적은 접기 안(기본 접힘).
 * - ② 표 밖 ※ 조건 문장(있을 때만).
 * - ③ 공지 표: 기본 '이 스택 행만'(이 스택이 쓰는 제품이 붙은 행), '전체'로 바꿈. 행이 많으면 표 안에서 세로로 스크롤.
 * - ④ 배포판 보안 추적기 근거(있을 때만 — 옛 서버 응답에는 없음): 구성 요소마다 CVE·상태·고친 판·확인 시각과 추적기 링크(새 창).
 * - ⑤ 공지 본문(접힘).
 *
 * 주소의 번호가 숫자가 아니면 읽지 않고 그 사실과 '목록으로', 없는 번호(404)는 '찾지 못함'과 '목록으로', 그 밖의 실패는 오류와 다시 시도. 화면 접근은 목록과
 * 같습니다 — 메뉴는 운영자에게만 보이고 막는 것은 백엔드(회원이 주소로 열면 API가 403 — 그 문구가 오류로 보임).
 */
export function NoticeScreen({ raw }: { raw: string }) {
  const ntt = parseNttParam(raw);
  const read = useApi<SecurityNoticeResponse>(ntt ? endpoints.security.notice(ntt) : null, 0);
  const notice = read.data?.notice ?? null;
  useEntityCrumb(ntt && notice ? securityNoticeHref(ntt) : null, notice?.title ?? null);

  if (!ntt) {
    return (
      <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
        <PageHeader title="보안 공지" actions={<BackLink />} />
        <Callout tone="warn" title="공지 번호가 올바르지 않습니다">
          주소의 공지 번호는 숫자여야 합니다. 목록에서 공지를 골라 &lsquo;자세히 보기&rsquo;로 들어오세요.
        </Callout>
      </div>
    );
  }

  const fallbackName = `보안 공지 ${ntt}`;
  if (!read.data) {
    const pending = firstLoadPending(read) || (read.loading && !read.error);
    const missing = read.errorStatus === 404;
    return (
      <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
        <EntityHeader
          kind={KIND}
          name={fallbackName}
          identifiers={[`글 ${ntt}`]}
          actions={<BackLink />}
          placeholder={pending ? <Skeleton lines={2} label="공지를 불러오는 중" /> : null}
        />
        {pending ? (
          <Skeleton lines={8} label="공지를 불러오는 중" />
        ) : missing ? (
          <Callout tone="warn" title="이 번호의 공지를 찾지 못했습니다">
            받아 둔 보안 공지(최근 90일)에 없는 번호입니다. 목록에서 다시 골라 주세요.
          </Callout>
        ) : read.error ? (
          <ErrorState message={read.error} onRetry={read.reload} />
        ) : null}
      </div>
    );
  }

  const data = read.data;
  const detail = data.notice;
  const url = safeExternalUrl(detail.url);
  const verdict = verdictView(detail.verdict);
  const fetched = detail.detailFetchedAt ? ` · ${formatKst(detail.detailFetchedAt)}` : "";
  return (
    <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
      <EntityHeader
        kind={KIND}
        name={detail.title || fallbackName}
        identifiers={[`글 ${detail.nttId}`]}
        tags={detail.pinned ? <Tag>고정</Tag> : null}
        description={`게시 ${detail.postedOn ?? EMPTY} · ${layoutLabel(detail.layout)} · 상세 ${detailStatusLabel(detail.detailStatus)}${fetched}`}
        badges={
          <>
            <VerdictText code={detail.verdict} />
            {detail.reasons.length > 0 ? <span className="break-keep text-sm text-text-2">{reasonsText(detail.reasons)}</span> : null}
          </>
        }
        actions={
          <>
            <BackLink />
            {url ? (
              <a href={url} target="_blank" rel="noopener noreferrer" className={buttonClasses("default", "md")}>
                원문 열기(새 창)
                <ExternalLinkIcon size={14} />
              </a>
            ) : null}
          </>
        }
      />

      <EnvironmentPanel data={data} verdictNote={verdict.description} />

      {detail.conditionNotes.length > 0 ? (
        <Callout tone="warn" title={`표 밖 조건 문장(※) ${detail.conditionNotes.length}개`}>
          <ul className="mt-1 flex flex-col gap-1">
            {detail.conditionNotes.map((note, index) => (
              <li key={index} className="wrap-anywhere">
                {note}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      <NoticeTablePanel rows={data.rows} layout={detail.layout} />

      <TrackerPanel data={data} />

      <Panel title="공지 본문">
        {detail.bodyText?.trim() ? (
          <Fold summary={`본문 펼치기(${detail.bodyText.trim().length.toLocaleString("ko-KR")}자)`}>
            <div className="max-w-[72ch] whitespace-pre-line break-keep wrap-anywhere text-running text-text-2">{detail.bodyText.trim()}</div>
          </Fold>
        ) : (
          <p className="text-sm text-text-2">받아 둔 본문이 없습니다(상세를 받기 전이거나 본문이 비었음).</p>
        )}
      </Panel>

      <p className="break-keep text-caption text-text-2">{SECURITY_LIMIT_NOTE}</p>
    </div>
  );
}

/** '목록으로' — 보안 공지 목록(같은 탭). */
function BackLink() {
  return (
    <Link href={LIST_HREF} className={buttonClasses("default", "md")}>
      목록으로
    </Link>
  );
}

/** ① 이 환경 판정 표의 열 — 판정·제품·구역·설치 판·해결 판·사유/근거. */
const EVIDENCE_COLUMNS: readonly Column<EvidenceLine>[] = [
  { key: "verdict", header: "판정", className: "whitespace-nowrap", cell: (line) => <VerdictText code={line.status} /> },
  { key: "product", header: "제품", rowHeader: true, className: "min-w-[7rem] break-keep", cell: (line) => line.product },
  { key: "source", header: "구역", className: "whitespace-nowrap", cell: (line) => sectionLabel(line.source) },
  {
    key: "installed",
    header: "설치 판",
    className: "min-w-[9rem] break-keep wrap-anywhere",
    cell: (line) => (line.installed.length > 0 ? <StackedValues values={line.installed} /> : null),
  },
  {
    key: "fixed",
    header: "해결 판",
    className: "min-w-[8rem] break-keep wrap-anywhere",
    cell: (line) => (line.fixed.length > 0 ? <StackedValues values={line.fixed} /> : null),
  },
  { key: "reason", header: "사유·근거", className: "min-w-[10rem] break-keep text-text-2", cell: (line) => evidenceReasonText(line) },
];

/** 값 여럿을 줄마다 — 칸 안에서 '/'로 잇지 않고 한 줄에 하나(설치 판·해결 판). */
function StackedValues({ values }: { values: readonly string[] }) {
  if (values.length === 1) return <>{values[0]}</>;
  return (
    <ul className="flex flex-col">
      {values.map((value) => (
        <li key={value}>{value}</li>
      ))}
    </ul>
  );
}

/** ① 이 환경 판정 — 걸린 것(해당·확인 필요) 표, 패치됨·무관은 건수를 적은 접기 안. */
function EnvironmentPanel({ data, verdictNote }: { data: SecurityNoticeResponse; verdictNote: string }) {
  const view = environmentLines(data);
  const reasonNotes = data.notice.reasons.map((code) => ({ code, text: reasonDescription(code) })).filter((line) => line.text);
  return (
    <Panel
      title="이 환경 판정"
      count={`해당·확인 필요 ${view.exposed.length}줄`}
      subtitle="같은 제품·구역·판정의 근거를 한 줄로 묶었습니다. 패치됨·무관은 접어 둡니다."
    >
      <div className="flex min-w-0 flex-col gap-3">
        <p className="break-keep text-sm text-text-2">{verdictNote}</p>
        {reasonNotes.length > 0 ? (
          <ul className="flex flex-col gap-1 text-caption text-text-2">
            {reasonNotes.map((line) => (
              <li key={line.code} className="break-keep">
                {reasonLabel(line.code)}: {line.text}
              </li>
            ))}
          </ul>
        ) : null}
        {!data.inventory ? <Callout tone="warn">{NO_INVENTORY_NOTE} 그때까지 제품이 맞는 공지는 확인 필요입니다.</Callout> : null}
        <DataTable<EvidenceLine>
          dense
          caption="이 환경에 걸린 것"
          rows={view.exposed}
          rowKey={(line) => line.key}
          scrollHint="overflow"
          emptyText="해당·확인 필요인 근거가 없습니다."
          columns={EVIDENCE_COLUMNS}
        />
        {view.patched.length > 0 ? (
          <Fold summary={`패치됨 ${view.patched.length}개`}>
            <DataTable<EvidenceLine>
              dense
              caption="패치됨"
              rows={view.patched}
              rowKey={(line) => line.key}
              scrollHint="overflow"
              columns={EVIDENCE_COLUMNS}
            />
          </Fold>
        ) : null}
        {view.unrelated.length > 0 ? (
          <Fold summary={`무관 ${view.unrelated.length}개`}>
            <DataTable<EvidenceLine>
              dense
              caption="무관"
              rows={view.unrelated}
              rowKey={(line) => line.key}
              scrollHint="overflow"
              columns={EVIDENCE_COLUMNS}
            />
          </Fold>
        ) : null}
      </div>
    </Panel>
  );
}

/** ③ 공지 표의 열 — CVE·제품·영향받는 버전·해결 버전(칸 원문)·이 행 판정. */
const ROW_COLUMNS: readonly Column<SecurityNoticeRow>[] = [
  { key: "cve", header: "CVE", rowHeader: true, className: "min-w-[9rem] break-keep wrap-anywhere font-mono", cell: (row) => row.cve },
  { key: "product", header: "제품", className: "min-w-[8rem] break-keep", cell: (row) => row.product },
  { key: "affected", header: "영향받는 버전", className: "min-w-[9rem] break-keep wrap-anywhere", cell: (row) => row.affected },
  { key: "fixed", header: "해결 버전", className: "min-w-[8rem] break-keep wrap-anywhere", cell: (row) => row.fixed },
  {
    key: "status",
    header: "이 행 판정",
    className: "min-w-[8rem]",
    cell: (row) => (
      <span className="flex flex-col gap-0.5">
        <VerdictText code={row.status} />
        {row.reasons.length > 0 ? <span className="break-keep text-caption text-text-2">{reasonsText(row.reasons)}</span> : null}
      </span>
    ),
  },
];

/** ③ 공지 표 — 기본 '이 스택 행만', '전체'로 바꿈. 표가 없는 공지는 그 사실 한 줄. */
function NoticeTablePanel({ rows, layout }: { rows: readonly SecurityNoticeRow[]; layout: string | null }) {
  const [scope, setScope] = useState<NoticeRowScope>("stack");
  const shown = scope === "stack" ? stackRows(rows) : rows;
  return (
    <Panel title="공지 표" count={rows.length > 0 ? `${rows.length}행` : undefined}>
      {rows.length === 0 ? (
        <p className="break-keep text-sm text-text-2">이 공지에는 제품 버전 표가 없습니다(표 틀: {layoutLabel(layout)}).</p>
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          <FilterList
            label="공지 표 범위"
            selection="single"
            wide="wrap"
            items={rowScopeItems(rows)}
            selected={[scope]}
            onToggle={(key) => setScope(key === "all" ? "all" : "stack")}
          />
          <DataTable<SecurityNoticeRow>
            dense
            caption={scope === "stack" ? "공지 표 — 이 스택 행" : "공지 표 — 전체"}
            rows={shown}
            rowKey={(row) => String(row.index)}
            scrollHint="overflow"
            maxHeight={NOTICE_TABLE_MAX_HEIGHT}
            emptyText="이 스택이 쓰는 제품의 행이 없습니다 — '전체'로 바꾸면 모든 행이 보입니다."
            columns={ROW_COLUMNS}
          />
        </div>
      )}
    </Panel>
  );
}

type TrackerEvidence = { key: string; match: SecurityMatch & { tracker: NonNullable<SecurityMatch["tracker"]> } };

/** 추적기 근거가 있는 근거(행 근거·행에 매이지 않는 근거 전부, 나온 차례). 옛 서버 응답(칸 없음)은 빈 목록. */
function trackerEvidence(data: SecurityNoticeResponse): TrackerEvidence[] {
  const all = [...data.rows.flatMap((row) => row.matches ?? []), ...(data.generalMatches ?? [])];
  return all
    .filter((match): match is TrackerEvidence["match"] => Boolean(match.tracker))
    .map((match, index) => ({ key: `${match.aliasId}|${match.source ?? ""}|${match.component ?? ""}|${index}`, match }));
}

/** ④ 배포판 보안 추적기 — 구성 요소마다 CVE·상태·고친 판·확인 시각과 추적기 링크(새 창). 추적기 근거가 없으면 그리지 않습니다. */
function TrackerPanel({ data }: { data: SecurityNoticeResponse }) {
  const items = trackerEvidence(data);
  if (items.length === 0) return null;
  return (
    <Panel
      title="배포판 보안 추적기"
      count={`${items.length}개 구성 요소`}
      subtitle="변경 기록에 없는 CVE를 배포판 보안 추적기(Ubuntu·Debian·Alpine)에서 확인한 결과입니다. 서버 수집기가 하루 몇 번 묻습니다."
    >
      <div className="flex min-w-0 flex-col gap-4">
        {items.map(({ key, match }) => {
          const installed = match.component ? `${match.component}${match.installedVersion ? ` ${match.installedVersion}` : ""}` : null;
          const heading = [match.label ?? match.aliasId, sectionLabel(match.source), installed, trackerName(match.tracker)].filter(Boolean).join(" · ");
          return (
            <section key={key} className="min-w-0">
              <h3 className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 break-keep wrap-anywhere text-sm font-semibold text-text">
                <span>{heading}</span>
                <VerdictText code={match.status} />
              </h3>
              <DataTable<SecurityTrackerCve>
                dense
                caption={`추적기 — ${heading}`}
                rows={match.tracker.cves}
                rowKey={(cve) => cve.cve}
                scrollHint="overflow"
                emptyText="추적기에 물을 CVE가 없습니다."
                columns={trackerColumns(match.tracker.distro)}
              />
            </section>
          );
        })}
      </div>
    </Panel>
  );
}

/** 추적기 표의 열 — CVE(추적기 링크, 새 창)·상태(아이콘 + 글)·고친 판·확인 시각(KST). */
function trackerColumns(distro: string): Column<SecurityTrackerCve>[] {
  return [
    {
      key: "cve",
      header: "CVE",
      rowHeader: true,
      className: "whitespace-nowrap font-mono",
      cell: (cve) => {
        const href = trackerUrl(distro, cve.cve);
        return href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className={`${LINK_CLASSES} gap-1`}>
            {cve.cve}
            <span className="sr-only">(새 창)</span>
            <ExternalLinkIcon size={12} />
          </a>
        ) : (
          cve.cve
        );
      },
    },
    {
      key: "status",
      header: "상태",
      className: "whitespace-nowrap",
      cell: (cve) => {
        const view = trackerStatusView(cve.status);
        return <StatusText tone={view.tone}>{view.label}</StatusText>;
      },
    },
    { key: "fixed", header: "고친 판", className: "min-w-[8rem] break-keep wrap-anywhere", cell: (cve) => cve.fixedVersion },
    { key: "checked", header: "확인 시각", className: "whitespace-nowrap", cell: (cve) => (cve.checkedAt ? formatKst(cve.checkedAt) : null) },
  ];
}
