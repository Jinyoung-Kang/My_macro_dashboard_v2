"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState, type FocusEvent, type MouseEvent } from "react";
import { DataTable, FilterList, PropertyList, Timeline, type FilterListItem, type TimelineEntry } from "@/components/patterns";
import { Button, buttonClasses, Callout, ErrorState, Freshness, inputClasses, LINK_CLASSES, Loading, PageHeader, Panel, Select, Tag } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useSessionUser } from "@/hooks/useSessionUser";
import { DEMO_READ_ONLY, isDemo } from "@/lib/access";
import { ALERT_KINDS, alertKindTag, inboxKinds, notifyAlertsRead } from "@/lib/alerts";
import { apiDelete, apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { EMPTY, formatKst, withoutLeadingIcon } from "@/lib/format";
import { filerName } from "@/lib/holdings";
import { searchWatchInboxHref } from "@/lib/infoSearch";
import type { AlertKind, AlertRule, AlertRulesResponse, InboxItem, InboxResponse } from "@/lib/types";

type Result = { ok: boolean; message: string };

/** 규칙 표 줄의 쓰기 — 켜기·끄기(POST {enabled})와 지우기(DELETE). */
type RuleAction = "toggle" | "delete";

/** 규칙 표 안 작은 단추 — 공용 Button(sm)과 같은 모양에, 요청 중(aria-disabled)이면 꺼진 단추처럼 보임(QA-898 — 원문 번역 단추 QA-887과 같은 꼴). */
const RULE_BUTTON = `${buttonClasses("default", "sm")} aria-disabled:cursor-not-allowed aria-disabled:opacity-50`;

/** 폼 이름표 — 공용 고르기 상자(Select)와 같은 13px 보조 글(text-2), 위 이름표·아래 칸(form-label-styles-mixed의 이 화면 몫 — 예전 12px text-3). */
const FIELD_LABEL = "flex min-w-0 flex-col gap-1 text-[13px] text-text-2";

/**
 * 알림 — 화면 알림함과 알림 규칙(명세 C, D2: 화면 알림함만).
 *
 * 알림은 대시보드를 열어야 보입니다(메일·메신저로 보내지 않음). 상단바 알림 벨과 탭 제목에 읽지 않은 수가 뜹니다.
 * 규칙을 만든 날 이후의 사건만 들어오고, 사건은 수집이 확정된 데이터로만 만듭니다(잠정치 제외).
 * 데모 열람(ADR 0013)은 읽기 전용이라 읽음 처리·규칙 만들기·켜기/끄기·지우기를 막습니다(백엔드도 403).
 * 정보 검색 관심 대상의 새 글 알림(SEARCH_WATCH — 그 대상에서 켠 것, 규칙 없음)은 제목을 누르면 그 대상의 타임라인으로 갑니다(정보 검색 화면 안쪽 주소만).
 * 그 알림은 규칙 없이 들어오므로 빈 알림함과 규칙 만들기(알림 종류 목록 아래)에 어디서 켜고 끄는지 적습니다(QA-443 — 데모 열람은 관심 대상을 읽지 않아 빼고).
 *
 * 작업대 P7(실행 명세 §7 7행 '알림: 타임라인과 필터 태그'): 알림함은 시각순 목록(Timeline — 발생일 열·종류 태그·제목 + '새 알림'·'지난 사건' 태그) + 화면 안
 * 거르기 둘(알림 종류·읽음 상태 — 요청 없음) + 검사 칸(넓은 화면 왼쪽 목록 + 넓은 검사 칸, 첫 알림이 저절로 보임 / 좁은 화면 대화상자). 줄 단추 안에 단추를 둘 수
 * 없어 '읽음'과 정보 검색 링크는 검사 칸으로 옮겼습니다(같은 POST·켜짐 조건 — 계획 U8).
 */
export default function AlertsPage() {
  const demo = isDemo(useSessionUser());
  const inbox = useApi<InboxResponse>(endpoints.alerts.inbox(50), 300_000);
  const rules = useApi<AlertRulesResponse>(endpoints.alerts.rules, 0);
  const institutions = useApi<{ institutions?: { cik: string; name: string }[] }>(endpoints.institution.institutions, 0);

  const read = useAsyncAction((ids: number[] | null) =>
    apiPost<{ changed: number }>(endpoints.alerts.read, ids === null ? { all: true } : { ids }), "읽음 처리에 실패했습니다.");
  const create = useAsyncAction((kind: AlertKind, params: Record<string, unknown>) =>
    apiPost<Result>(endpoints.alerts.rules, { kind, params }), "규칙을 만들지 못했습니다.");
  const toggle = useAsyncAction((id: number, enabled: boolean) =>
    apiPost<Result>(endpoints.alerts.rule(id), { enabled }), "바꾸지 못했습니다.");
  const remove = useAsyncAction((id: number) => apiDelete<Result>(endpoints.alerts.rule(id)), "지우지 못했습니다.");

  const [kind, setKind] = useState<AlertKind>("REGIME_CHANGE");
  const [target, setTarget] = useState("KOSPI");
  const [code, setCode] = useState("");
  const [days, setDays] = useState("5");
  const [cik, setCik] = useState("");

  const reloadAll = () => {
    void rules.reload();
    void inbox.reload();
  };

  // 규칙 표 줄의 쓰기(QA-898). 단추의 켜짐 조건은 예전 그대로(disabled={demo})이고, 그 줄의 쓰기와 뒤따른 규칙 다시 읽기가 끝날 때까지 같은 줄 두 단추의
  // 누름만 무시합니다(aria-disabled로 요청 중임을 알림 — 진짜 disabled가 아니라 포커스가 남음). 예전에는 두 번 누르거나 Enter를 되풀이하면 같은 POST·DELETE가
  // 두 번 가고, 두 번째 DELETE는 서버 404라 지운 직후 경고가 떴습니다. 경로·메서드·본문·확인 없음은 그대로(moreWritesKeep). 다른 줄은 그대로 누를 수 있습니다.
  // 누른 단추에 포커스가 있었고 끝난 뒤 포커스가 <body>면(지운 줄이 사라짐 등) 그 줄의 같은 단추 → 누를 때의 다음 줄의 같은 단추 → 표(가로 스크롤 상자)로 옮깁니다.
  const ruleBusy = useRef(new Set<number>());
  const [busyRules, setBusyRules] = useState<ReadonlySet<number>>(() => new Set());
  const [ruleRefocus, setRuleRefocus] = useState<{ id: number; action: RuleAction; next: number | null } | null>(null);
  const rulesTable = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ruleRefocus === null) return;
    setRuleRefocus(null);
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const box = rulesTable.current;
    if (box === null) return;
    const find = (id: number | null) =>
      id === null ? null : box.querySelector<HTMLElement>(`[data-rule-id="${id}"][data-rule-action="${ruleRefocus.action}"]`);
    (find(ruleRefocus.id) ?? find(ruleRefocus.next) ?? box.querySelector<HTMLElement>('[role="region"]'))?.focus();
  }, [ruleRefocus]);
  const ruleWrite = async (event: MouseEvent<HTMLButtonElement>, row: AlertRule, action: RuleAction) => {
    if (ruleBusy.current.has(row.id)) return;
    ruleBusy.current.add(row.id);
    setBusyRules(new Set(ruleBusy.current));
    const hadFocus = document.activeElement === event.currentTarget;
    const shown = rules.data?.rules ?? [];
    const next = shown[shown.findIndex((rule) => rule.id === row.id) + 1]?.id ?? null;
    try {
      if (action === "toggle") await toggle.run(row.id, !row.enabled);
      else await remove.run(row.id);
      const reloaded = rules.reload();
      void inbox.reload();
      await reloaded;
    } finally {
      ruleBusy.current.delete(row.id);
      setBusyRules(new Set(ruleBusy.current));
      if (hadFocus) setRuleRefocus({ id: row.id, action, next });
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // 요청 중이면 다시 보내지 않습니다 — 단추는 요청 동안 aria-disabled라(QA-899) 입력칸 Enter의 폼 보내기를 막지 못합니다.
    if (demo || create.busy) return;
    const params: Record<string, unknown> =
      kind === "FOREIGN_STREAK" ? { target, n: Number(days), ...(target === "STOCK" ? { code } : {}) }
        : kind === "INSTITUTION_NEW" ? { cik }
        : {};
    await create.run(kind, params);
    reloadAll();
  };

  if (rules.loading && !rules.data) return <Loading label="알림을 읽는 중…" />;
  if (rules.error) return <ErrorState message={rules.error} onRetry={rules.reload} />;
  if (rules.data && !rules.data.available) return <Callout tone="warn">{rules.data.message}</Callout>;

  const items = inbox.data?.items ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
      <PageHeader
        title="알림"
        description="알림은 이 화면에만 쌓입니다(메일·메신저로 보내지 않음). 대시보드를 열면 위쪽 알림 벨과 탭 제목에 읽지 않은 수가 보입니다."
      />

      <Panel
        title="알림함"
        subtitle={`읽지 않은 알림 ${inbox.data ? `${inbox.data.unread}건` : EMPTY} · 90일 보관`}
        actions={
          <span className="flex items-center gap-2">
            {/* 자동 갱신(5분)이 실패하면 새 알림이 들어오지 않은 채 남으므로 '새로 읽지 못함'을 붙입니다(QA-104). */}
            <Freshness refreshError={inbox.refreshError} />
            <Button onClick={async () => { await read.run(null); void inbox.reload(); notifyAlertsRead(); }} disabled={demo || !inbox.data?.unread} busy={read.busy}>
              모두 읽음
            </Button>
          </span>
        }
      >
        {inbox.error && <ErrorState message={inbox.error} onRetry={inbox.reload} />}
        {/* 읽음 처리가 실패하면 목록만 다시 읽혀 항목이 그대로 남을 뿐 이유가 보이지 않았습니다(QA-103). */}
        {read.error && (
          <div className="mb-3">
            <Callout tone="warn">{read.error}</Callout>
          </div>
        )}
        {/* 읽는 중·실패에는 '아직 알림이 없습니다'가 아닙니다(QA-050). */}
        {!inbox.data ? (
          inbox.loading ? <Loading /> : null
        ) : items.length === 0 ? (
          <p className="text-xs text-text-3">
            {demo ? `아직 알림이 없습니다. ${DEMO_READ_ONLY}(알림 규칙은 계정으로 로그인해야 만들 수 있습니다).`
              : "아직 알림이 없습니다. 아래에서 알림 규칙을 만드세요. 정보 검색에서 관심 대상의 ‘알림’을 켜면 그 대상의 새 글 알림은 규칙 없이 여기에 들어옵니다."}
          </p>
        ) : (
          <InboxTimeline
            items={items}
            demo={demo}
            readError={read.error}
            onRead={async (id) => { await read.run([id]); void inbox.reload(); notifyAlertsRead(); }}
          />
        )}
      </Panel>

      <Panel
        title="알림 규칙"
        subtitle={`${rules.data?.rules?.length ?? 0}/${rules.data?.limit ?? 0}개 · 규칙을 만든 날 이후의 사건만 들어옵니다`}
      >
        {(toggle.error || remove.error) && (
          <div className="mb-3">
            <Callout tone="warn">{toggle.error ?? remove.error}</Callout>
          </div>
        )}
        <div ref={rulesTable}>
          <DataTable<AlertRule>
            dense
            count
            scrollHint="overflow"
            caption="알림 규칙"
            rows={rules.data?.rules ?? []}
            rowKey={(row) => String(row.id)}
            emptyText="규칙이 없습니다."
            columns={[
              { key: "desc", header: "알림", rowHeader: true, className: "min-w-[12rem] break-keep", cell: (row) => withoutLeadingIcon(row.description) },
              { key: "created", header: "만든 날", className: "whitespace-nowrap", cell: (row) => formatKst(row.createdAt) },
              {
                key: "enabled",
                header: "상태",
                // 표 안 조작은 작은 단추(넓은 화면 24px — 명세 §3-7, table-cell-controls-md-30의 이 화면 몫).
                cell: (row) => (
                  <button
                    type="button"
                    disabled={demo}
                    aria-disabled={busyRules.has(row.id) || undefined}
                    data-rule-id={row.id}
                    data-rule-action="toggle"
                    onClick={(event) => void ruleWrite(event, row, "toggle")}
                    className={RULE_BUTTON}
                  >
                    {row.enabled ? "켜짐 — 끄기" : "꺼짐 — 켜기"}
                  </button>
                ),
              },
              {
                key: "delete",
                header: <span className="sr-only">지우기</span>,
                align: "right",
                cell: (row) => (
                  <button
                    type="button"
                    disabled={demo}
                    aria-disabled={busyRules.has(row.id) || undefined}
                    data-rule-id={row.id}
                    data-rule-action="delete"
                    onClick={(event) => void ruleWrite(event, row, "delete")}
                    className={RULE_BUTTON}
                  >
                    지우기
                  </button>
                ),
              },
            ]}
          />
        </div>

        <form onSubmit={submit} className="mt-5 flex max-w-md flex-col gap-3">
          <h3 className="text-sm font-semibold text-text">규칙 만들기</h3>
          <Select label="알림 종류" value={kind} onChange={(value) => setKind(value as AlertKind)}
            options={ALERT_KINDS.map((k) => ({ value: k.value, label: k.pro ? `${k.label} · 유료` : k.label }))} />
          {!demo && (
            <p className="text-xs text-text-3">
              정보 검색 관심 대상의 새 글 알림은 규칙을 만들지 않습니다 — 정보 검색의 관심 대상 목록, 또는 대상을 열었을 때 ‘관심 대상 해제’ 옆에 있는 종 모양
              ‘알림’ 단추로 대상마다 켜고 끕니다.
              켠 대상은 새 글이 들어오면 위 알림함에 한 줄을 남깁니다(15분마다 확인).
            </p>
          )}
          {kind === "FOREIGN_STREAK" && (
            <>
              <Select label="대상" value={target} onChange={setTarget}
                options={[{ value: "KOSPI", label: "코스피 전체" }, { value: "KOSDAQ", label: "코스닥 전체" },
                  { value: "STOCK", label: "관심 종목" }]} />
              {target === "STOCK" && (
                <label className={FIELD_LABEL}>
                  종목코드(6자리)
                  <input value={code} onChange={(event) => setCode(event.target.value.trim())} placeholder="005930"
                    className={`w-full sm:max-w-[22rem] ${inputClasses()}`} />
                </label>
              )}
              <Select label="연속 일수" value={days} onChange={setDays}
                options={[3, 5, 7, 10, 15, 20].map((n) => ({ value: String(n), label: `${n}일` }))} />
              <p className="text-xs text-text-3">
                토스증권 확정 기록 기준(당일 잠정치 제외). 시장 전체의 외국인은 등록+비등록, 종목은 등록 외국인입니다.
              </p>
            </>
          )}
          {/* 기관 이름은 서버 글 그대로면 국기가 붙어 옵니다 — 13F·교집합 화면과 같이 뗀 이름(비면 CIK). */}
          {kind === "INSTITUTION_NEW" && (
            <Select label="관심 기관" value={cik} onChange={setCik}
              options={[{ value: "", label: "기관을 고르세요" },
                ...(institutions.data?.institutions ?? []).map((i) => ({ value: i.cik, label: filerName(i.name) ?? `CIK ${i.cik}` }))]} />
          )}
          {create.error && <Callout tone="warn">{create.error}</Callout>}
          {create.result && <Callout tone={create.result.ok ? "ok" : "warn"}>{create.result.message}</Callout>}
          <Button variant="primary" type="submit"
            disabled={demo || (kind === "INSTITUTION_NEW" && !cik) || (kind === "FOREIGN_STREAK" && target === "STOCK" && !/^\d{6}$/.test(code))} busy={create.busy}>
            {create.busy ? "만드는 중…" : "규칙 만들기"}
          </Button>
          {demo && <p className="text-xs text-text-3">{DEMO_READ_ONLY}</p>}
        </form>
      </Panel>
    </div>
  );
}

const ALL = "all";
const UNREAD = "unread";

/**
 * 알림함 시각순 목록 + 거르기 + 검사 칸. 거르기는 받은 알림 안에서만(요청 없음) — 알림 종류는 받은 종류만(전체 + 국면 전환·연속 순매수·13F 신규·관심 대상
 * 새 글), 읽음 상태는 전체·읽지 않음. 둘 다 하나 고름(공용 거르기 목록 — 라디오, 강조 파랑 없는 잉크 고름).
 * 줄: 발생일 · 종류 태그(중립) · 제목(그림 문자 뗌) + 읽지 않은 새 알림이면 굵은 제목과 '새 알림' 태그, 발생 3일 뒤에 들어온 알림이면 '지난 사건' 태그
 * (예전 '●' 점만 첫 줄에 홀로 남던 것 — D1 alerts-unread-dot-alone — 과 옛 15px 제목이 없어짐).
 */
function InboxTimeline({
  items,
  demo,
  readError,
  onRead,
}: {
  items: readonly InboxItem[];
  demo: boolean;
  readError: string | null;
  onRead: (id: number) => Promise<void>;
}) {
  const [kindFilter, setKindFilter] = useState<string>(ALL);
  const [readFilter, setReadFilter] = useState<string>(ALL);
  const kinds = inboxKinds(items);
  const kindItems: FilterListItem[] = [{ key: ALL, label: "전체" }, ...kinds.map((kind) => ({ key: kind, label: alertKindTag(kind) }))];
  // 받은 종류가 바뀌어 고른 종류가 사라지면 전체로 봅니다.
  const kindShown = kindFilter === ALL || kinds.includes(kindFilter as AlertKind) ? kindFilter : ALL;
  const shown = items.filter(
    (item) => (kindShown === ALL || item.kind === kindShown) && (readFilter === ALL || !item.read),
  );
  const byKey = new Map(items.map((item) => [String(item.id), item]));
  const shownKeys = shown.map((item) => String(item.id));

  // '읽음' 뒤 포커스(QA-866) — 누른 알림이 다시 읽은 알림함에서 읽음이 되면 그 단추가 사라집니다(읽지 않은 알림에만 그림). 포커스가 <body>로 떨어졌으면
  // 그 알림의 줄 단추로(넓은 화면 옆 검사 칸 — 목록에서 이어 감), 거르기('읽지 않음')로 줄이 빠졌으면 누를 때의 다음 줄(없으면 앞 줄) 단추로 옮깁니다 —
  // 좁은 화면 대화상자는 그 줄이 빠지면 닫히고, 되돌아갈 줄 단추가 없어 공용 대화상자의 되돌리기가 하지 못합니다(그래서 그 뒤 차례에 옮김). 넓은 화면에서
  // 줄이 빠져 검사 칸이 다음 알림으로 바뀌어도 검사 칸 내용은 알림마다 새로 그려(InboxDetail의 key) 누른 단추가 사라지므로 같은 길입니다(QA-881). 줄이 하나도
  // 남지 않으면 '읽음 상태' 거르기의 고른 줄로. 포커스가 다른 곳(대화상자 안 — 거르기 없음)에 있으면 건드리지 않습니다. 쓰기·켜짐 조건은 그대로입니다.
  // '읽음'을 누르지 않았는데 알림함을 다시 읽어(5분 자동 갱신·탭 복귀) 넓은 화면 검사 칸 안의 포커스 요소가 사라져도(새 알림이 맨 위에 와 저절로 고른
  // 줄이 바뀜 · 다른 곳에서 읽어 거르기에서 빠지거나 '읽음'만 사라짐) <body>로 떨어졌습니다(QA-884). 그래서 검사 칸 안에서 마지막으로 포커스를 받은 요소를
  // 적어 두고(detailFocus — 대화상자는 DOM이 이 틀 밖이라 적지 않음), 다시 읽은 뒤 그 요소가 사라지고 포커스가 <body>면 지금 고른 줄 단추로(없으면 앞
  // 대상의 줄, 그것도 없으면 '읽음 상태' 고른 줄) 옮깁니다. 다른 요소로 옮겼거나 빈 곳을 눌러 떠났으면 지웁니다(창 전환은 포커스 요소가 그대로라 남김).
  const rootRef = useRef<HTMLDivElement>(null);
  const pendingRead = useRef<{ key: string; next: string | null } | null>(null);
  const detailFocus = useRef<{ element: Element; key: string | null } | null>(null);
  const shownList = shownKeys.join("\n");
  useEffect(() => {
    const pending = pendingRead.current;
    let pick: (root: HTMLElement) => HTMLElement | null;
    let options: FocusOptions | undefined;
    if (pending !== null) {
      const item = items.find((entry) => String(entry.id) === pending.key);
      if (item !== undefined && !item.read) return;
      pendingRead.current = null;
      const keys = shownList === "" ? [] : shownList.split("\n");
      const target = keys.includes(pending.key) ? pending.key : pending.next !== null && keys.includes(pending.next) ? pending.next : null;
      pick = (root) => (target === null ? null : root.querySelector<HTMLElement>(`[data-item-key="${target}"]`));
    } else {
      const lost = detailFocus.current;
      if (lost === null || lost.element.isConnected) return;
      pick = (root) =>
        root.querySelector<HTMLElement>('[data-item-key][aria-current="true"]') ??
        (lost.key === null ? null : root.querySelector<HTMLElement>(`[data-item-key="${lost.key}"]`));
      // 사용자가 누른 뒤가 아니라 읽기가 바꾼 것이라 화면을 굴리지 않습니다(다른 곳을 보고 있었을 수 있음).
      options = { preventScroll: true };
    }
    detailFocus.current = null;
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      const root = rootRef.current;
      if (root === null) return;
      (pick(root) ?? root.querySelector<HTMLElement>('[role="radiogroup"][aria-label="읽음 상태"] [aria-checked="true"]'))?.focus(options);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [items, shownList]);
  const onFocusIn = (event: FocusEvent<HTMLDivElement>) => {
    const target: EventTarget = event.target;
    const detail = target instanceof Element && event.currentTarget.contains(target) ? target.closest("[data-inbox-detail]") : null;
    detailFocus.current = detail === null ? null : { element: target as Element, key: detail.getAttribute("data-inbox-detail") };
  };
  const onFocusOut = (event: FocusEvent<HTMLDivElement>) => {
    const record = detailFocus.current;
    if (record === null || record.element !== event.target) return;
    if (event.relatedTarget !== null) {
      detailFocus.current = null;
      return;
    }
    window.setTimeout(() => {
      if (detailFocus.current === record && record.element.isConnected && document.activeElement !== record.element) detailFocus.current = null;
    }, 0);
  };
  const readOne = async (id: number) => {
    const key = String(id);
    const index = shownKeys.indexOf(key);
    pendingRead.current = { key, next: shownKeys[index + 1] ?? shownKeys[index - 1] ?? null };
    await onRead(id);
  };

  const entries: TimelineEntry[] = shown.map((item) => {
    const fresh = !item.read && !item.late;
    return {
      key: String(item.id),
      at: item.occurredOn,
      dateTime: item.occurredOn,
      kind: { label: alertKindTag(item.kind) },
      title: withoutLeadingIcon(item.title),
      summary: (
        <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className={fresh ? "font-semibold text-text" : "text-text"}>{withoutLeadingIcon(item.title)}</span>
          {fresh ? <Tag>새 알림</Tag> : null}
          {item.late ? <Tag>지난 사건</Tag> : null}
        </span>
      ),
    };
  });

  return (
    <div ref={rootRef} onFocus={onFocusIn} onBlur={onFocusOut} className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-2">
        <FilterList label="알림 종류" selection="single" wide="wrap" items={kindItems} selected={[kindShown]} onToggle={setKindFilter} />
        {/* 거른 뒤의 개수를 낭독기에 알립니다(공용 거르기 목록의 알림 영역 — QA-879). 거르기가 둘이라 같은 글을 두 번 읽지 않게 영역은 이 하나에만 둡니다. */}
        <FilterList
          label="읽음 상태"
          selection="single"
          wide="wrap"
          items={[{ key: ALL, label: "전체" }, { key: UNREAD, label: "읽지 않음" }]}
          selected={[readFilter]}
          onToggle={setReadFilter}
          status={`고른 조건의 알림 ${shown.length.toLocaleString("ko-KR")}건`}
        />
      </div>
      <Timeline
        label="알림함"
        entries={entries}
        count
        emptyText="고른 조건에 맞는 알림이 없습니다."
        inspectorWidth="wide"
        dialogFocus="title"
        autoSelectFirst
        inspectorHint="알림을 고르면 이 칸에 본문이 나옵니다."
        renderDetail={(entry) => {
          const item = byKey.get(entry.key);
          // 알림마다 새로 그립니다(key) — 넓은 화면에서 '읽지 않음' 거르기로 읽은 알림이 빠져 검사 칸이 다음 알림으로 바뀌면, 같은 자리의 '읽음' 단추가
          // 이어 쓰여 포커스가 다음 알림의 쓰기 단추에 안내 없이 남았습니다(Enter 한 번이 다음 알림을 읽음 처리 — QA-881). 새로 그리면 그 단추가 사라져
          // 위 '읽음' 뒤 포커스 규칙이 남은 다음 줄 단추로 옮깁니다.
          return item ? <InboxDetail key={item.id} item={item} demo={demo} readError={readError} onRead={readOne} /> : null;
        }}
      />
    </div>
  );
}

/**
 * 알림 검사 칸 — 발생일·받은 시각·상태·지난 사건(속성 목록), 본문(긴 글 15/24, 줄바꿈 그대로, 그림 문자 뗌), 관심 대상 새 글이면 그 대상의 정보 검색 링크
 * (정보 검색 화면 안쪽 주소만 — lib/infoSearch), 읽지 않았고 데모가 아니면 '읽음'(같은 POST {ids:[id]} — 누른 뒤 알림함 다시 읽기·읽음 신호). 읽음 처리 실패는
 * 알림함 머리 아래와 여기 둘 다에 적습니다(대화상자가 열려 있으면 바깥 글이 가려짐).
 */
function InboxDetail({
  item,
  demo,
  readError,
  onRead,
}: {
  item: InboxItem;
  demo: boolean;
  readError: string | null;
  onRead: (id: number) => Promise<void>;
}) {
  const href = searchWatchInboxHref(item);
  return (
    <div data-inbox-detail={item.id} className="flex min-w-0 flex-col gap-3">
      <PropertyList
        dense
        items={[
          { label: "발생일", value: item.occurredOn },
          { label: "받은 시각", value: formatKst(item.createdAt) },
          { label: "상태", value: item.read ? "읽음" : "읽지 않음" },
          { label: "지난 사건", value: item.late ? "예 — 발생 3일 뒤에 들어옴(읽지 않은 수에 세지 않음)" : "아니요" },
        ]}
      />
      <p className="max-w-[72ch] whitespace-pre-line break-keep wrap-anywhere text-running text-text-2">{withoutLeadingIcon(item.body)}</p>
      {href || (!item.read && !demo) ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {href ? (
            <Link href={href} className={LINK_CLASSES}>
              정보 검색에서 보기
            </Link>
          ) : null}
          {!item.read && !demo ? (
            // 켜짐 조건은 개편 전 줄 안 '읽음'과 같습니다 — 보이는 조건(읽지 않음·데모 아님)만, 요청 중에도 꺼지지 않음(QA-863).
            <Button size="sm" onClick={() => void onRead(item.id)}>
              읽음
            </Button>
          ) : null}
        </div>
      ) : null}
      {readError ? <Callout tone="warn">{readError}</Callout> : null}
    </div>
  );
}
