"use client";

import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { type Column, DataTable, EntityHeader, type PropertyItem, PropertyList, ProvenanceBadge, Skeleton, SplitPane } from "@/components/patterns";
import { Callout, ErrorState, Freshness, LINK_CLASSES, Panel, Select, Tag, tabId, Tabs } from "@/components/ui";
import { ScaleIcon, StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { EMPTY, withMinusSign } from "@/lib/format";
import { REGIME_AS_OF_NOTE, regimeHeroModel } from "@/lib/home";
import { macroPath } from "@/lib/marketSections";
import { regimeBandLabel } from "@/lib/regime";
import { SOURCES } from "@/lib/sources";
import type { RegimeResponse } from "@/lib/types";
import { RegimeLogSection } from "./RegimeLogSection";
import { RegimeTag } from "./RegimeTag";
import { TrackRecordSection } from "./TrackRecordSection";

/**
 * 시장 국면.
 *
 * <p>성장·신용 축(금리차·NFCI·하이일드)과 유동성 축(순유동성 4주 방향)으로
 * 지금이 4국면 중 어디인지 판정합니다.
 *
 * <p>주의: 입력 지표가 하나라도 없으면 <b>판정하지 않습니다.</b> 빠진 값을 0으로
 * 메우면 "중립"이라는 틀린 판정이 됩니다 — 이 프로젝트가 지키는 규칙입니다.
 *
 * <p>판정 대상 화면(작업대 대상 문법 — 실행 명세 §7 '국면 판정'): 대상 머리(지금 판정이 주 값) → 칸 틀 — 왼쪽 판정 근거 넷(속성), 가운데 네 국면
 * 사분면과 탭 셋(판정 기록 타임라인·국면 이력·판정 성과), 오른쪽 연결(쓰인 지표가 있는 화면)·출처. 좁은 화면은 한 칸이고 왼쪽 근거를 접지 않습니다
 * (근거가 판정의 핵심).
 */
const QUADRANTS = [
  { code: "EXPANSION", label: "확장", axis: "성장·신용 양호 + 유동성 확대" },
  { code: "LATE", label: "후퇴 경계", axis: "성장·신용 양호 + 유동성 축소" },
  { code: "RECOVERY", label: "회복", axis: "성장·신용 악화 + 유동성 확대" },
  { code: "CONTRACTION", label: "침체 경계", axis: "성장·신용 악화 + 유동성 축소" },
];

const TIMELINE_COLOR: Record<string, string> = {
  EXPANSION: "bg-ok/70",
  LATE: "bg-warn/70",
  // 회복은 진한 회색(text-2) — 판정 불가(border 옅은 회색)와 명도가 크게 달라 한 띠에서 갈립니다.
  RECOVERY: "bg-text-2",
  CONTRACTION: "bg-danger/70",
  UNKNOWN: "bg-border",
};

/** 판정 대상 종류 — 상세 화면 셋 밖의 대상이라 종류 글과 아이콘(저울)을 넘깁니다. */
const KIND = { label: "국면 판정", icon: ScaleIcon };

/**
 * 연결 — 판정에 쓴 지표가 있는 화면·절. 신호마다의 지표 상세(/markets/i/…)는 매크로 카드 키로만 있어 신호 id(curve·nfci·hyOas·liquidity)와 맞지
 * 않으므로, 그 지표의 차트가 있는 매크로 화면(lib/marketSections 정본)과 순유동성 화면으로 잇습니다. 링크 글에 어느 화면·절인지 적습니다.
 * 매크로 링크는 절 조각 없이 화면 맨 위로 갑니다 — 자료가 온 뒤 위 절들이 자라 해시 스크롤이 그 절에 머물지 않았습니다(QA-641). 절은 그 화면의 목차로 옮깁니다.
 */
const LINKS = [
  { label: "장단기 금리차 10Y-3M · NFCI — 매크로 지표의 심화 매크로 지표", href: macroPath() },
  { label: "하이일드 스프레드 — 매크로 지표의 신용 리스크·변동성", href: macroPath() },
  { label: "연준 순유동성 4주 변화 — 순유동성 화면", href: "/liquidity" },
];

type Episode = NonNullable<RegimeResponse["episodes"]>[number];

/** 과거 구간 표의 열 — 국면은 태그(톤 + 아이콘 + 이름), 날짜는 그대로, 기간은 주. */
const EPISODE_COLUMNS: readonly Column<Episode>[] = [
  { key: "label", header: "국면", cell: (row) => <RegimeTag code={row.code} label={row.label} /> },
  { key: "start", header: "시작", cell: (row) => row.start },
  { key: "end", header: "끝", cell: (row) => row.end },
  { key: "weeks", header: "기간", align: "right", cell: (row) => `${row.weeks}주` },
];

type RegimeTabKey = "log" | "history" | "track";

/**
 * 가운데 탭 셋 — 공용 탭 줄(밑줄, ARIA tabs, 좁은 화면 44px)과 탭 패널 하나. 탭마다의 내용은 **모두 마운트**하고 고르지 않은 것은 hidden입니다 — 화면을
 * 열 때 판정 기록·판정 성과를 한 번씩 읽는 요청 시점·횟수가 탭이 없던 때와 같고, 탭을 오가도 고른 기록·자산·관점이 남습니다(QA-066·101).
 * 고른 탭은 화면 안 상태(주소 그대로), 처음은 판정 기록. 상세 화면의 탭 감싸개(DetailTabs)와 같은 꼴의 작은 중복입니다(공용화는 P8 후보 — ADR 0004 규칙 4).
 */
function RegimeTabs({ tabs }: { tabs: readonly { key: RegimeTabKey; label: string; content: ReactNode }[] }) {
  const baseId = useId();
  const idPrefix = `${baseId}-tab`;
  const panelId = `${baseId}-panel`;
  const [current, setCurrent] = useState<RegimeTabKey>("log");
  return (
    <div className="min-w-0">
      <Tabs label="국면 판정 내용" items={tabs.map(({ key, label }) => ({ key, label }))} value={current} onChange={setCurrent} idPrefix={idPrefix} panelId={panelId} size="sm" />
      <div role="tabpanel" id={panelId} aria-labelledby={tabId(idPrefix, current)} className="mt-3 min-w-0">
        {tabs.map((tab) => (
          <div key={tab.key} hidden={tab.key !== current} className="flex min-w-0 flex-col gap-3 lg:gap-4">
            {tab.content}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function RegimePage() {
  const [years, setYears] = useState("5");
  const { data, error, reload, refreshError } = useApi<RegimeResponse>(endpoints.insight.regime(years), 300_000);

  const verdict = data?.verdict;
  const model = regimeHeroModel(data);
  const bandLabel = regimeBandLabel(data?.timeline, (data?.episodes ?? []).length);
  // 응답 전에는 값 자리에 자리표시 — 읽기가 실패했으면 오류 상자와 다시 시도. 이름·이력 기간 고르기는 그대로 남습니다(QA-047).
  const pending = data ? null : error ? <ErrorState message={error} onRetry={reload} /> : <Skeleton lines={2} label="국면을 판정하는 중" />;

  // 판정 근거 넷 — 홈 국면 패널과 같은 모델(자리 고정 — 받지 못한 신호는 —와 '받지 못함', 자릿수·부호 −가 같음, QA-636). 값은 정상·주의 톤 글자색,
  // 아래 보조 글은 상태 글(정상·주의 아이콘 — 주의만 '주의:', QA-505) + 해석. 판정 근거는 좁은 칸이라 이름 위·값 아래(block).
  const signalItems: PropertyItem[] = model.tiles.map((tile) => {
    const signal = verdict?.signals.find((entry) => entry.id === tile.id);
    const healthy = signal?.healthy ?? false;
    return {
      key: tile.id,
      label: tile.label,
      value: tile.valueText ? <span className={healthy ? "text-ok" : "text-warn"}>{withMinusSign(tile.valueText)}</span> : null,
      unit: tile.unit,
      emptyReason: tile.emptyReason,
      block: true,
      note: signal ? (
        <>
          {/* align-top: 글 줄 안의 inline-flex가 기준선에 앉아 보조 글 줄이 2px 높아지지 않게(SpreadSection의 상태 글과 같음). */}
          <StatusText tone={healthy ? "ok" : "warn"} colorText={false} iconSize={12} className="align-top">
            {signal.state}
          </StatusText>{" "}
          {signal.reading}
        </>
      ) : null,
    };
  });

  const history = data ? (
    <>
      {/* 띠는 이름 있는 그림 하나(기간·구간 수 — 자세한 구간은 아래 표)이고 칸은 읽기에서 뺍니다. 칸·견본은 바탕색으로만 그리므로 고대비(forced-colors)에서
          바탕색이 지워지지 않게 색을 그대로 둡니다(forced-color-adjust-none — 범례 견본·차트 견본과 같은 규칙, QA-635·QA-497). */}
      {bandLabel ? (
        <div role="img" aria-label={bandLabel} className="flex h-8 w-full overflow-hidden rounded-sm border border-border forced-color-adjust-none">
          {(data.timeline ?? []).map((point) => (
            <span
              key={point.date}
              aria-hidden="true"
              className={`h-full flex-1 ${TIMELINE_COLOR[point.code] ?? "bg-border"}`}
              title={`${point.date} · ${point.label}`}
            />
          ))}
        </div>
      ) : null}
      {/* 범례 — 띠 색 견본 + 국면 태그(톤 + 아이콘 + 이름 — 색만으로 국면을 가르지 않음). */}
      <ul aria-label="국면 이력 띠 범례" className="mt-2 flex flex-wrap gap-x-3 gap-y-2 text-xs text-text-3">
        {[...QUADRANTS, { code: "UNKNOWN", label: "판정 불가" }].map((quadrant) => (
          <li key={quadrant.code} className="flex items-center gap-1.5">
            <span data-band-swatch aria-hidden="true" className={`h-2 w-4 rounded-xs forced-color-adjust-none ${TIMELINE_COLOR[quadrant.code]}`} />
            <RegimeTag code={quadrant.code} label={quadrant.label} />
          </li>
        ))}
      </ul>

      <div className="mt-5">
        <h3 className="mb-2 text-sm font-semibold text-text">과거 구간 (최근 순)</h3>
        <DataTable
          caption="과거 구간 (최근 순)"
          rows={(data.episodes ?? []).slice(0, 15)}
          rowKey={(row) => `${row.code}-${row.start}`}
          emptyText="이력을 만들 수 없습니다. 지표 저장본을 먼저 수집하세요."
          columns={EPISODE_COLUMNS}
        />
      </div>
    </>
  ) : error ? (
    <p className="break-keep text-sm text-text-2">국면을 읽지 못해 이력을 그리지 못했습니다. 위 머리의 다시 시도를 누르세요.</p>
  ) : (
    <Skeleton lines={4} label="국면 이력을 읽는 중" />
  );

  return (
    <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
      <EntityHeader
        kind={KIND}
        name="시장 국면"
        description={verdict?.summary}
        identifiers={verdict ? [verdict.code] : undefined}
        valueLabel="지금 판정"
        value={verdict?.label ?? null}
        emptyReason="판정을 받지 못함"
        badges={
          <>
            <ProvenanceBadge source={SOURCES.regime} asOf={data?.asOf} />
            {verdict ? (
              <>
                <Tag>성장·신용 {verdict.growthAxis}</Tag>
                <Tag>유동성 {verdict.liquidityAxis}</Tag>
              </>
            ) : null}
          </>
        }
        actions={
          <>
            {/* 자동 갱신이 실패하면 앞서 받은 값을 그대로 보이므로 '새로 읽지 못함'을 붙입니다(QA-104, QA-067과 같음). */}
            <Freshness refreshError={refreshError} />
            <Select
              label="이력 기간"
              value={years}
              onChange={setYears}
              options={["3", "5", "10"].map((value) => ({ value, label: `최근 ${value}년` }))}
            />
          </>
        }
        placeholder={pending}
      />

      {verdict && !data?.available ? (
        <Callout tone="warn" title="판정 불가">
          {model.missing.length > 0 ? (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {model.missing.map((item) => (
                <li key={item}>{item}를 받지 못했습니다.</li>
              ))}
            </ul>
          ) : (
            verdict.summary
          )}
        </Callout>
      ) : null}

      <SplitPane
        left={
          <Panel title="판정 근거" subtitle="결론에 동의하지 않아도 근거는 그대로 확인할 수 있어야 합니다.">
            <PropertyList items={signalItems} placeholder={data ? undefined : <Skeleton lines={4} label="판정 근거 불러오는 중" />} />
            {data ? (
              <p className="mt-2 break-keep text-xs leading-4 text-text-3">
                기준일 <span className="tabular-nums">{model.asOf ?? EMPTY}</span> — {REGIME_AS_OF_NOTE}
              </p>
            ) : null}
            {model.note ? (
              <p className="mt-2 rounded-sm border border-border bg-bg px-3 py-2 text-xs text-text-3">
                <StatusText tone="warn" colorText={false} iconSize={12}>
                  {model.note}
                </StatusText>
              </p>
            ) : null}
          </Panel>
        }
        right={
          <>
            <Panel title="연결">
              <ul className="flex flex-col lg:gap-1.5">
                {LINKS.map((link) => (
                  <li key={link.label} className="min-w-0">
                    <Link href={link.href} className={`${LINK_CLASSES} break-keep text-sm wrap-anywhere`}>
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
            <Panel title="출처">
              <PropertyList
                items={[
                  { label: "판정·근거", value: SOURCES.regime, block: true },
                  { label: "판정 기록", value: SOURCES.regimeLog, block: true },
                  { label: "판정 성과", value: SOURCES.regimeTrackRecord, block: true },
                ]}
              />
            </Panel>
          </>
        }
      >
        <Panel title="네 국면" subtitle="성장·신용 축 × 유동성 축 — 두 축의 방향으로 국면을 정합니다.">
          <ul aria-label="네 국면" className="grid gap-2 sm:grid-cols-2">
            {QUADRANTS.map((quadrant) => {
              const now = quadrant.code === verdict?.code;
              return (
                // 지금 칸은 잉크 테두리 + '지금' 글 + aria-current — 색만으로 가리지 않습니다(고대비에서도 테두리·글이 남음).
                <li
                  key={quadrant.code}
                  aria-current={now ? "true" : undefined}
                  className={`min-w-0 rounded-control border px-3 py-2 ${now ? "border-text bg-surface-2" : "border-border bg-bg"}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <RegimeTag code={quadrant.code} label={quadrant.label} />
                    {now ? <span className="text-xs font-semibold text-text">지금</span> : null}
                  </div>
                  <p className="mt-1 break-keep text-xs text-text-2">{quadrant.axis}</p>
                </li>
              );
            })}
          </ul>
        </Panel>

        <RegimeTabs
          tabs={[
            { key: "log", label: "판정 기록", content: <RegimeLogSection /> },
            {
              key: "history",
              label: "국면 이력",
              content: (
                <Panel
                  title="국면 이력"
                  source={SOURCES.regime}
                  subtitle="같은 규칙을 과거 날짜에 그대로 적용한 재현입니다(매주 목요일). 회색은 판정 불가 — 하이일드 스프레드 이력이 2023-09부터라 그 이전은 판정할 수 없습니다."
                >
                  {history}
                </Panel>
              ),
            },
            // 판정 성과는 스스로 읽습니다 — 이력 기간을 바꿔 판정을 다시 읽는 동안에도 그대로 두어 고른 자산·관점이 처음으로 돌아가지 않습니다(QA-066).
            { key: "track", label: "판정 성과", content: <TrackRecordSection /> },
          ]}
        />
      </SplitPane>
    </div>
  );
}
