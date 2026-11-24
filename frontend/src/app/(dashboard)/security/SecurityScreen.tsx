"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Pager } from "@/components/Pager";
import { DataTable, FilterList, InspectorFrame, type InspectorContext, InspectorTrigger, KpiStrip } from "@/components/patterns";
import { Callout, EmptyState, ErrorState, FIELD_LABEL, Loading, PageHeader, Panel, Tabs, Tag, buttonClasses, inputClasses, tabId } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { firstLoadPending, useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { EMPTY } from "@/lib/format";
import {
  ALL,
  SECURITY_LIMIT_NOTE,
  SECURITY_PAGE_SIZE,
  collectionLine,
  filterParam,
  inventoryState,
  notOkSectionsText,
  parseNttParam,
  reasonFilterItems,
  reasonsText,
  securityKpis,
  staleInventoryText,
  verdictFilterItems,
} from "@/lib/security";
import type { SecurityInventoryResponse, SecurityNoticeItem, SecurityNoticesResponse } from "@/lib/types";
import { InventoryPanel } from "./InventoryPanel";
import { NoticeSummary } from "./NoticeSummary";
import { VerdictText } from "./VerdictText";

type TabKey = "notices" | "inventory";

const TABS: readonly { key: TabKey; label: string }[] = [
  { key: "notices", label: "공지" },
  { key: "inventory", label: "버전 목록" },
];

/**
 * 보안 공지(/security, ADR 0046) — KISA 보호나라 보안공지를 이 서버·컨테이너의 실제 버전과 대조한 판정(해당·확인 필요·패치됨·무관)을 봅니다. 운영자 전용이고
 * 읽기만 합니다(쓰기 경로 없음 — '확인함' 표시는 범위 밖, 결정 9의 4). 판정은 백엔드가 읽을 때 계산하고, 화면 조회는 수집을 일으키지 않습니다.
 *
 * 작업대 화면 언어(ADR 0042): 머리 → 한계 한 줄(늘 보임) → 버전 목록·수집 상태 안내 → KPI 띠(해당·확인 필요·패치됨·버전 목록 기준 시각) → 탭(공지 | 버전 목록).
 * 공지 탭은 검색 + 거르기 둘(판정·사유 — API의 verdict·reason·q 인자, 고르면 첫 쪽부터 다시 읽음) + 조밀 표 + 요약 칸(넓은 틀은 옆 28rem, 그 밖은 대화상자 —
 * 판정·사유 한 줄, 이 환경에 걸린 것(해당·확인 필요만), 패치됨·무관 줄 수, ※ 조건 문장 수, '자세히 보기'(상세 페이지 /security/<번호>)·원문 링크 — NoticeSummary).
 * 표 행마다의 판정·추적기 근거 같은 긴 내용은 상세 페이지(NoticeScreen)에만 둡니다(2026-11-21 사용자 결정). 버전 목록 탭은 그 탭을 열 때만 읽습니다.
 * 판정은 늘 아이콘 + 글입니다(색만으로 가르지 않음 — 위험색과 상승색이 가까움, ADR 0042 결정 3).
 *
 * 알림함의 보안 공지 알림은 `/security?ntt=<번호>`로 옵니다 — 그 번호의 공지 요약 칸을 엽니다(넓은 틀은 옆 칸에 고름, 그 밖은 대화상자). 그 공지가 지금 쪽에
 * 없어도 엽니다(제목은 '보안 공지 <번호>' — 검사 칸이 그 공지를 따로 읽음).
 */
export function SecurityScreen() {
  const params = useSearchParams();
  const linked = parseNttParam(params.get("ntt"));
  const tabsId = useId();
  const panelId = `${tabsId}-panel`;
  const [tab, setTab] = useState<TabKey>("notices");
  const [verdict, setVerdict] = useState(ALL);
  const [reason, setReason] = useState(ALL);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  // 알림함 링크로 열 공지 — 검사 칸 틀이 그려지면 한 번 열고 비웁니다. 같은 화면에서 다른 번호의 링크로 오면 다시 엽니다.
  const [openTarget, setOpenTarget] = useState<string | null>(null);
  useEffect(() => {
    if (linked === null) return;
    setTab("notices");
    setVerdict(ALL);
    setReason(ALL);
    setDraft("");
    setQuery("");
    setPage(1);
    setOpenTarget(linked);
  }, [linked]);
  const opened = useCallback(() => setOpenTarget(null), []);

  const notices = useApi<SecurityNoticesResponse>(
    endpoints.security.notices({ verdict: filterParam(verdict), reason: filterParam(reason), q: query, page, size: SECURITY_PAGE_SIZE }),
    300_000,
  );
  const inventory = useApi<SecurityInventoryResponse>(tab === "inventory" ? endpoints.security.inventory : null, 0);
  const data = notices.data;

  // 판정별 건수(counts)는 검색어로만 거른 수라 판정·사유·쪽을 바꿔 다시 읽는 동안에도 같습니다 — 그 검색어로 받은 마지막 건수를 KPI 띠·판정 거르기에 이어 씁니다
  // (검색어가 바뀌면 이어 쓰지 않음 — 옛 숫자를 새 조건의 결과로 보이지 않게). 버전 목록 요약·수집 상태는 거르기와 무관해 마지막 응답 그대로.
  const [kept, setKept] = useState<{ query: string; data: SecurityNoticesResponse } | null>(null);
  if (data && kept?.data !== data) setKept({ query, data });
  const base = data ?? kept?.data ?? null;
  const counts = data?.counts ?? (kept && kept.query === query ? kept.data.counts : null);

  const resetList = () => {
    setPage(1);
    setSelected(null);
  };
  const search = (event: FormEvent) => {
    event.preventDefault();
    setQuery(draft.trim());
    resetList();
  };

  // 건수를 아직 모르는 동안(처음 읽기·검색어를 바꿔 다시 읽기)은 KPI 타일이 읽는 중 자리 — '표 없음'으로 적지 않습니다.
  const kpiPending = (firstLoadPending(notices) && !base) || (counts === null && notices.loading);
  const kpiSource = base ? { ...base, counts } : null;

  return (
    <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
      <PageHeader
        title="보안 공지"
        description="KISA 보호나라 보안공지를 이 서버와 컨테이너의 실제 버전과 대조합니다. 판정은 해당·확인 필요·패치됨·무관 넷이고, 판정할 수 없는 것은 확인 필요로 둡니다."
      />
      <Callout title="이 화면의 한계">{SECURITY_LIMIT_NOTE}</Callout>

      {notices.error && !base ? (
        <ErrorState message={notices.error} onRetry={notices.reload} />
      ) : base && !base.available ? (
        <EmptyState message="보안 공지 표가 아직 없습니다 — 수집기가 새 스키마를 적용한 뒤 보입니다." />
      ) : (
        <>
          {/* 상태 줄은 응답 뒤에 생기는 긴 한 줄(수집 상태·받아 둔 공지 — 넓은 화면 두 줄, 좁은 화면 네 줄 안팎)이라, 읽는 중에는 그 높이의 빈 자리를 둡니다
              (QA-995 — 응답 뒤 끼어든 줄이 탭과 목록을 밀었음). 글은 응답 뒤 그대로입니다. */}
          {base ? <StatusLines data={base} /> : notices.error ? null : <div aria-hidden="true" className="h-20 md:h-10" />}
          <KpiStrip label="판정 요약" items={securityKpis(kpiSource, kpiPending)} />
          <Tabs label="보안 공지 보기" items={TABS} value={tab} onChange={setTab} idPrefix={tabsId} panelId={panelId} />
          <div role="tabpanel" id={panelId} aria-labelledby={tabId(tabsId, tab)} className="min-w-0">
            {tab === "notices" ? (
              <Panel
                title="공지"
                count={data ? `모두 ${data.total}건` : undefined}
                subtitle="게시일 최근부터. 제목을 고르면 이 환경에 걸린 것만 요약하고, '자세히 보기'에서 공지 한 건의 판정 표·공지 표·추적기 근거를 봅니다."
              >
                <div className="flex min-w-0 flex-col gap-3">
                  <form className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end" onSubmit={search}>
                    <label className={FIELD_LABEL}>
                      제목·제품·CVE 검색
                      {/* 셸의 거르기 칸 표지(data-shell-filter — '/'로 이 칸에 포커스) — 이 화면에 하나입니다. */}
                      <input
                        type="search"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        className={inputClasses("md")}
                        maxLength={100}
                        data-shell-filter=""
                      />
                    </label>
                    <button type="submit" className={buttonClasses("secondary", "md")}>
                      찾기
                    </button>
                  </form>
                  <FilterList
                    label="판정"
                    selection="single"
                    wide="wrap"
                    items={verdictFilterItems(counts)}
                    selected={[verdict]}
                    onToggle={(key) => {
                      setVerdict(key);
                      resetList();
                    }}
                  />
                  <FilterList
                    label="사유"
                    selection="single"
                    wide="wrap"
                    items={reasonFilterItems(data?.reasonCounts ?? null)}
                    selected={[reason]}
                    onToggle={(key) => {
                      setReason(key);
                      resetList();
                    }}
                  />
                  <NoticeList
                    read={notices}
                    linked={linked}
                    openTarget={openTarget}
                    onOpened={opened}
                    selected={selected}
                    onSelect={setSelected}
                    onPage={(next) => {
                      setPage(next);
                      setSelected(null);
                    }}
                  />
                </div>
              </Panel>
            ) : (
              <InventoryPanel read={inventory} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 버전 목록·수집 상태 안내 — 버전 목록이 없으면 '버전 목록 없음'(주의), 2일 넘게 오래됐으면 경고, 모으지 못한 구역이 있으면 그 이름, 그리고 수집 상태 한 줄
 * (아이콘 + 글).
 */
function StatusLines({ data }: { data: SecurityNoticesResponse }) {
  const state = inventoryState(data.inventory);
  const line = collectionLine(data.collection, data.checkedAt);
  const notOk = state.kind === "present" ? notOkSectionsText(state.notOkSections) : null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {state.kind === "missing" ? (
        <Callout tone="warn" title={state.text}>
          그때까지 제품이 맞는 공지는 모두 확인 필요(버전 목록 없음)이고 알림이 가지 않습니다.
        </Callout>
      ) : null}
      {state.kind === "present" && state.stale ? <Callout tone="warn">{staleInventoryText(state)}</Callout> : null}
      {notOk ? <Callout tone="warn">{notOk}</Callout> : null}
      {line ? (
        <p className="min-w-0 text-sm text-text-2">
          <StatusText tone={line.tone} colorText={false} className="wrap-anywhere">
            {line.text}
          </StatusText>
        </p>
      ) : null}
    </div>
  );
}

type NoticeRead = { data: SecurityNoticesResponse | null; loading: boolean; error: string | null; reload: () => void; failedAt: Date | null };

/**
 * 공지 표 + 검사 칸. 읽는 중이면 '불러오는 중', 실패면 오류와 다시 시도. 줄이 없어도 틀을 그려 알림함 링크의 공지(지금 쪽에 없는 번호 포함)를 열 수 있게 합니다.
 */
function NoticeList({
  read,
  linked,
  openTarget,
  onOpened,
  selected,
  onSelect,
  onPage,
}: {
  read: NoticeRead;
  linked: string | null;
  openTarget: string | null;
  onOpened: () => void;
  selected: string | null;
  onSelect: (key: string | null) => void;
  onPage: (page: number) => void;
}) {
  const { data, error, reload } = read;
  if (!data) {
    return error ? <ErrorState message={error} onRetry={reload} /> : <Loading label="공지를 불러오는 중…" />;
  }
  const byKey = new Map(data.items.map((item) => [String(item.nttId), item]));
  const titleOf = (key: string) => byKey.get(key)?.title ?? (key === linked ? `보안 공지 ${key}` : null);
  return (
    <div className="min-w-0">
      <InspectorFrame
        label="보안 공지"
        layout="wide"
        titleOf={titleOf}
        selectedKey={selected}
        onSelectedKeyChange={onSelect}
        dialogFocus="title"
        inspectorHint="제목을 고르면 이 칸에 이 환경에 걸린 것(해당·확인 필요)과 '자세히 보기'·원문 링크가 나옵니다."
        renderDetail={(key) => <NoticeSummary key={key} nttId={key} />}
      >
        {(inspector) => (
          <>
            {openTarget ? <OpenLinked inspector={inspector} target={openTarget} onDone={onOpened} /> : null}
            <DataTable<SecurityNoticeItem>
              dense
              caption="보안 공지"
              rows={data.items}
              rowKey={(row) => String(row.nttId)}
              selectedKey={inspector.shownKey}
              scrollHint="overflow"
              emptyText="조건에 맞는 공지가 없습니다."
              columns={[
                { key: "verdict", header: "판정", className: "whitespace-nowrap", cell: (row) => <VerdictText code={row.verdict} /> },
                {
                  key: "title",
                  header: "제목",
                  rowHeader: true,
                  className: "min-w-[16rem] break-keep",
                  cell: (row) => (
                    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                      <InspectorTrigger inspector={inspector} itemKey={String(row.nttId)} className="wrap-anywhere text-left">
                        {row.title}
                      </InspectorTrigger>
                      {row.pinned ? <Tag>고정</Tag> : null}
                    </span>
                  ),
                },
                {
                  key: "products",
                  header: "제품",
                  className: "min-w-[8rem] break-keep text-text-2",
                  cell: (row) => (row.products.length > 0 ? row.products.map((product) => product.label).join(" · ") : EMPTY),
                },
                {
                  key: "reasons",
                  header: "사유",
                  className: "min-w-[10rem] break-keep text-caption text-text-2",
                  cell: (row) => reasonsText(row.reasons) ?? EMPTY,
                },
                { key: "posted", header: "게시일", className: "whitespace-nowrap tabular-nums", cell: (row) => row.postedOn ?? EMPTY },
              ]}
            />
          </>
        )}
      </InspectorFrame>
      <Pager page={data.page ?? 1} pages={data.pages ?? 1} onChange={onPage} label="공지 목록" />
    </div>
  );
}

/** 알림함 링크의 공지를 한 번 엽니다(넓은 틀이면 옆 칸에 고르고, 그 밖은 대화상자) — 연 뒤 부르는 쪽이 비웁니다. */
function OpenLinked({ inspector, target, onDone }: { inspector: InspectorContext; target: string; onDone: () => void }) {
  const { inspect } = inspector;
  useEffect(() => {
    inspect(target);
    onDone();
  }, [inspect, target, onDone]);
  return null;
}
