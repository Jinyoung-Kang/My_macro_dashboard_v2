"use client";

import { useState } from "react";
import {
  Banner,
  Card,
  ErrorState,
  Freshness,
  Loading,
  Metric,
  Select,
  SourceBadge,
  Table,
} from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { EMPTY, formatNumber } from "@/lib/format";
import type { RegimeResponse, RegimeSignal } from "@/lib/types";
import { SOURCES } from "@/lib/sources";
import { endpoints } from "@/lib/endpoints";
import { RegimeLogSection } from "./RegimeLogSection";
import { TrackRecordSection } from "./TrackRecordSection";

/**
 * 🧭 시장 국면.
 *
 * <p>성장·신용 축(금리차·NFCI·하이일드)과 유동성 축(순유동성 4주 방향)으로
 * 지금이 4국면 중 어디인지 판정합니다.
 *
 * <p>⚠️ 입력 지표가 하나라도 없으면 <b>판정하지 않습니다.</b> 빠진 값을 0으로
 * 메우면 "중립"이라는 틀린 판정이 됩니다 — 이 프로젝트가 지키는 규칙입니다.
 */
const QUADRANTS = [
  {
    code: "EXPANSION",
    label: "확장",
    axis: "성장·신용 양호 + 유동성 확대",
    tone: "border-ok/50 bg-ok/10 text-ok",
  },
  {
    code: "LATE",
    label: "후퇴 경계",
    axis: "성장·신용 양호 + 유동성 축소",
    tone: "border-warn/50 bg-warn/10 text-warn",
  },
  {
    code: "RECOVERY",
    label: "회복",
    axis: "성장·신용 악화 + 유동성 확대",
    tone: "border-accent/50 bg-accent/10 text-accent",
  },
  {
    code: "CONTRACTION",
    label: "침체 경계",
    axis: "성장·신용 악화 + 유동성 축소",
    tone: "border-danger/50 bg-danger/10 text-danger",
  },
];

const TIMELINE_COLOR: Record<string, string> = {
  EXPANSION: "bg-ok/70",
  LATE: "bg-warn/70",
  RECOVERY: "bg-accent/70",
  CONTRACTION: "bg-danger/70",
  UNKNOWN: "bg-border",
};

export default function RegimePage() {
  const [years, setYears] = useState("5");
  const { data, loading, error, reload, refreshError } = useApi<RegimeResponse>(
    endpoints.insight.regime(years),
    300_000,
  );


  const verdict = data?.verdict;
  const current = QUADRANTS.find((entry) => entry.code === verdict?.code);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-bright">시장 국면</h1>
          <p className="mt-1 text-xs text-muted">
            성장·신용 축 × 유동성 축 · 기준일 {data?.asOf ?? EMPTY}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* 자동 갱신이 실패하면 앞서 받은 값을 그대로 보이므로 '새로 읽지 못함'을 붙입니다(QA-104, QA-067과 같음). */}
          <Freshness refreshError={refreshError} />
          <Select
            label="이력 기간"
            value={years}
            onChange={setYears}
            options={["3", "5", "10"].map((value) => ({ value, label: `최근 ${value}년` }))}
          />
        </div>
      </header>

      {/* 컨트롤(머리말·첫 카드)은 늘 그리고 본문만 로딩·오류로 바꿉니다 — 페이지 전체를 바꾸면 방금 조작한
          선택 상자가 사라지고 키보드 포커스를 잃었습니다(QA-047). */}
      {loading && !data && <Loading label="국면을 판정하는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && (
        <>

        {verdict && !data?.available && (
          <Banner tone="warn">
            <strong>판정 불가</strong> — {verdict.summary}
            {(verdict.missing ?? []).length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-xs">
                {verdict.missing.map((item) => (
                  <li key={item}>{item}를 받지 못했습니다.</li>
                ))}
              </ul>
            )}
          </Banner>
        )}

        {verdict && (
          <Card
            title="지금 국면" source={SOURCES.regime}
            actions={current ? <SourceBadge>{verdict.code}</SourceBadge> : undefined}
          >
            <div
              className={`rounded-lg border px-4 py-4 ${
                current?.tone ?? "border-border bg-surface-hover text-muted"
              }`}
            >
              <p className="text-2xl font-bold">{verdict.label}</p>
              <p className="mt-2 text-sm leading-relaxed">{verdict.summary}</p>
              <p className="mt-2 text-xs">
                성장·신용 <strong>{verdict.growthAxis}</strong> · 유동성{" "}
                <strong>{verdict.liquidityAxis}</strong>
              </p>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {QUADRANTS.map((quadrant) => (
                <div
                  key={quadrant.code}
                  className={`rounded-lg border px-3 py-2 text-xs ${
                    quadrant.code === verdict.code
                      ? quadrant.tone
                      : "border-border bg-canvas text-muted"
                  }`}
                >
                  <p className="font-semibold">{quadrant.label}</p>
                  <p className="mt-0.5">{quadrant.axis}</p>
                </div>
              ))}
            </div>
          </Card>
        )}

        <Card
          title="판정 근거" source={SOURCES.regime}
          subtitle="결론에 동의하지 않아도 근거는 그대로 확인할 수 있어야 합니다."
        >
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {(verdict?.signals ?? []).map((signal: RegimeSignal) => (
              <Metric
                key={signal.id}
                label={signal.label}
                value={`${formatNumber(signal.value, 2)}${signal.unit ?? ""}`}
                tone={signal.healthy ? "text-ok" : "text-warn"}
                caption={signal.state}
                note={signal.reading}
              />
            ))}
          </div>
          {(verdict?.signals ?? []).length === 0 && (
            <p className="text-sm text-muted">판정에 쓸 신호를 하나도 받지 못했습니다.</p>
          )}
        </Card>

        </>
      )}

      {/* 스스로 데이터를 읽는 섹션은 이력 기간을 바꿔 판정을 다시 읽는 동안에도 그대로 둡니다 — `data &&` 안에
          두면 함께 내려가 판정 성과에서 고른 자산·관점이 처음으로 돌아갔습니다(QA-066). */}
      <TrackRecordSection tone={TIMELINE_COLOR} />

      <RegimeLogSection tone={TIMELINE_COLOR} />

      {data && (
        <>
        <Card
          title="국면 이력" source={SOURCES.regime}
          subtitle="같은 규칙을 과거 날짜에 그대로 적용한 재현입니다(매주 목요일). 회색은 판정 불가 — 하이일드 스프레드 이력이 2023-09부터라 그 이전은 판정할 수 없습니다."
        >
          <div className="flex h-8 w-full overflow-hidden rounded-sm border border-border">
            {(data?.timeline ?? []).map((point) => (
              <span
                key={point.date}
                className={`h-full flex-1 ${TIMELINE_COLOR[point.code] ?? "bg-border"}`}
                title={`${point.date} · ${point.label}`}
              />
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted">
            {QUADRANTS.map((quadrant) => (
              <span key={quadrant.code} className="flex items-center gap-1">
                <span className={`h-2 w-4 rounded-xs ${TIMELINE_COLOR[quadrant.code]}`} />
                {quadrant.label}
              </span>
            ))}
            <span className="flex items-center gap-1">
              <span className="h-2 w-4 rounded-xs bg-border" />
              판정 불가
            </span>
          </div>

          <div className="mt-5">
            <h3 className="mb-2 text-sm font-semibold text-bright">과거 구간 (최근 순)</h3>
            <Table
              rows={(data?.episodes ?? []).slice(0, 15)}
              rowKey={(row) => `${row.code}-${row.start}`}
              emptyMessage="이력을 만들 수 없습니다. 지표 저장본을 먼저 수집하세요."
              columns={[
                {
                  key: "label",
                  header: "국면",
                  render: (row) => (
                    <span className="flex items-center gap-2">
                      <span className={`h-2 w-4 rounded-xs ${TIMELINE_COLOR[row.code] ?? "bg-border"}`} />
                      {row.label}
                    </span>
                  ),
                },
                { key: "start", header: "시작", render: (row) => row.start },
                { key: "end", header: "끝", render: (row) => row.end },
                {
                  key: "weeks",
                  header: "기간",
                  align: "right",
                  render: (row) => `${row.weeks}주`,
                },
              ]}
            />
          </div>
        </Card>

        {data?.note && (
          <p className="rounded-sm border border-border bg-canvas px-3 py-2 text-xs text-muted">
            <StatusText tone="warn" colorText={false} iconSize={12}>{data.note}</StatusText>
          </p>
        )}
        </>
      )}
    </div>
  );
}
