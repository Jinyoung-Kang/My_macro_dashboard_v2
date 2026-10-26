"use client";

import { FormEvent, useState } from "react";
import { Banner, Button, Card, ErrorState, Freshness, Loading, Select, Table } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useSessionUser } from "@/hooks/useSessionUser";
import { DEMO_READ_ONLY, isDemo } from "@/lib/access";
import { ALERT_KINDS, notifyAlertsRead } from "@/lib/alerts";
import { apiDelete, apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { EMPTY, formatKst } from "@/lib/format";
import type { AlertKind, AlertRule, AlertRulesResponse, InboxItem, InboxResponse } from "@/lib/types";

type Result = { ok: boolean; message: string };

/**
 * 🔔 알림 — 화면 알림함과 알림 규칙(명세 C, D2: 화면 알림함만).
 *
 * 알림은 대시보드를 열어야 보입니다(메일·메신저로 보내지 않음). 상단바 알림 벨과 탭 제목에 읽지 않은 수가 뜹니다.
 * 규칙을 만든 날 이후의 사건만 들어오고, 사건은 수집이 확정된 데이터로만 만듭니다(잠정치 제외).
 * 데모 열람(ADR 0013)은 읽기 전용이라 읽음 처리·규칙 만들기·켜기/끄기·지우기를 막습니다(백엔드도 403).
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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (demo) return;
    const params: Record<string, unknown> =
      kind === "FOREIGN_STREAK" ? { target, n: Number(days), ...(target === "STOCK" ? { code } : {}) }
        : kind === "INSTITUTION_NEW" ? { cik }
        : {};
    await create.run(kind, params);
    reloadAll();
  };

  if (rules.loading && !rules.data) return <Loading label="알림을 읽는 중…" />;
  if (rules.error) return <ErrorState message={rules.error} onRetry={rules.reload} />;
  if (rules.data && !rules.data.available) return <Banner tone="warn">{rules.data.message}</Banner>;

  const items = inbox.data?.items ?? [];
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-bold text-bright">알림</h1>
        <p className="mt-1 text-xs text-muted">
          알림은 이 화면에만 쌓입니다(메일·메신저로 보내지 않음). 대시보드를 열면 위쪽 알림 벨과 탭 제목에 읽지 않은 수가 보입니다.
        </p>
      </header>

      <Card
        title="알림함"
        subtitle={`읽지 않은 알림 ${inbox.data ? `${inbox.data.unread}건` : EMPTY} · 90일 보관`}
        actions={
          <span className="flex items-center gap-2">
            {/* 자동 갱신(5분)이 실패하면 새 알림이 들어오지 않은 채 남으므로 '새로 읽지 못함'을 붙입니다(QA-104). */}
            <Freshness refreshError={inbox.refreshError} />
            <Button onClick={async () => { await read.run(null); void inbox.reload(); notifyAlertsRead(); }} disabled={demo || read.busy || !inbox.data?.unread}>
              모두 읽음
            </Button>
          </span>
        }
      >
        {inbox.error && <ErrorState message={inbox.error} onRetry={inbox.reload} />}
        {/* 읽음 처리가 실패하면 목록만 다시 읽혀 항목이 그대로 남을 뿐 이유가 보이지 않았습니다(QA-103). */}
        {read.error && <Banner tone="warn">{read.error}</Banner>}
        {/* 읽는 중·실패에는 '아직 알림이 없습니다'가 아닙니다(QA-050). */}
        {!inbox.data ? (
          inbox.loading ? <Loading /> : null
        ) : items.length === 0 ? (
          <p className="text-xs text-muted">
            {demo ? `아직 알림이 없습니다. ${DEMO_READ_ONLY}(알림 규칙은 계정으로 로그인해야 만들 수 있습니다).`
              : "아직 알림이 없습니다. 아래에서 알림 규칙을 만드세요."}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((item: InboxItem) => (
              <li
                key={item.id}
                className={`rounded-lg border p-3 ${item.read || item.late ? "border-border bg-canvas/40" : "border-accent/50 bg-accent/5"}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-bright">
                    {!item.read && !item.late && <span className="mr-1 text-accent">●</span>}
                    {item.title}
                  </p>
                  <span className="text-[11px] text-muted">
                    {item.occurredOn}{item.late ? " · 지난 사건" : ""}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-body">{item.body}</p>
                {!item.read && !demo && (
                  <button
                    type="button"
                    className="mt-2 text-[11px] text-muted underline hover:text-accent"
                    onClick={async () => { await read.run([item.id]); void inbox.reload(); notifyAlertsRead(); }}
                  >
                    읽음
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="알림 규칙"
        subtitle={`${rules.data?.rules?.length ?? 0}/${rules.data?.limit ?? 0}개 · 규칙을 만든 날 이후의 사건만 들어옵니다`}
      >
        {(toggle.error || remove.error) && <Banner tone="warn">{toggle.error ?? remove.error}</Banner>}
        <Table<AlertRule>
          rows={rules.data?.rules ?? []}
          rowKey={(row) => String(row.id)}
          emptyMessage="규칙이 없습니다."
          columns={[
            { key: "desc", header: "알림", render: (row) => row.description },
            { key: "created", header: "만든 날", render: (row) => formatKst(row.createdAt) },
            {
              key: "enabled",
              header: "상태",
              render: (row) => (
                <Button disabled={demo} onClick={async () => { await toggle.run(row.id, !row.enabled); reloadAll(); }}>
                  {row.enabled ? "켜짐 — 끄기" : "꺼짐 — 켜기"}
                </Button>
              ),
            },
            {
              key: "delete",
              header: "",
              render: (row) => (
                <Button disabled={demo} onClick={async () => { await remove.run(row.id); reloadAll(); }}>지우기</Button>
              ),
            },
          ]}
        />

        <form onSubmit={submit} className="mt-5 flex max-w-md flex-col gap-3">
          <h3 className="text-sm font-semibold text-bright">규칙 만들기</h3>
          <Select label="알림 종류" value={kind} onChange={(value) => setKind(value as AlertKind)}
            options={ALERT_KINDS.map((k) => ({ value: k.value, label: k.pro ? `${k.label} · 유료` : k.label }))} />
          {kind === "FOREIGN_STREAK" && (
            <>
              <Select label="대상" value={target} onChange={setTarget}
                options={[{ value: "KOSPI", label: "코스피 전체" }, { value: "KOSDAQ", label: "코스닥 전체" },
                  { value: "STOCK", label: "관심 종목" }]} />
              {target === "STOCK" && (
                <label className="text-xs text-muted">
                  종목코드(6자리)
                  <input value={code} onChange={(event) => setCode(event.target.value.trim())} placeholder="005930"
                    className="mt-1 w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-body outline-hidden focus:border-accent" />
                </label>
              )}
              <Select label="연속 일수" value={days} onChange={setDays}
                options={[3, 5, 7, 10, 15, 20].map((n) => ({ value: String(n), label: `${n}일` }))} />
              <p className="text-[11px] text-muted">
                토스증권 확정 기록 기준(당일 잠정치 제외). 시장 전체의 외국인은 등록+비등록, 종목은 등록 외국인입니다.
              </p>
            </>
          )}
          {kind === "INSTITUTION_NEW" && (
            <Select label="관심 기관" value={cik} onChange={setCik}
              options={[{ value: "", label: "기관을 고르세요" },
                ...(institutions.data?.institutions ?? []).map((i) => ({ value: i.cik, label: i.name }))]} />
          )}
          {create.error && <Banner tone="warn">{create.error}</Banner>}
          {create.result && <Banner tone={create.result.ok ? "info" : "warn"}>{create.result.message}</Banner>}
          <Button variant="primary" type="submit"
            disabled={demo || create.busy || (kind === "INSTITUTION_NEW" && !cik) || (kind === "FOREIGN_STREAK" && target === "STOCK" && !/^\d{6}$/.test(code))}>
            {create.busy ? "만드는 중…" : "규칙 만들기"}
          </Button>
          {demo && <p className="text-[11px] text-muted">{DEMO_READ_ONLY}</p>}
        </form>
      </Card>
    </div>
  );
}
