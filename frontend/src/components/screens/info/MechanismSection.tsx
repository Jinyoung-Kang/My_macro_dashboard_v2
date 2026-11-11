"use client";

import Link from "next/link";
import { useState } from "react";
import { Pager } from "@/components/Pager";
import { Banner, Card, ErrorState, Loading, Table } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { EMPTY, formatNumber } from "@/lib/format";
import { type MechanismResponse, PAGE_SIZE, minutesRange, pageSlice, tierLabel } from "@/lib/info";

type Collector = NonNullable<MechanismResponse["collector"]>;
type HostRow = Collector["hosts"][number] & { state: MechanismResponse["hostStates"][number] | null };
type CadenceRow = Collector["cadences"][number] & { nextDue: string | null };

/**
 * 정보(메커니즘) — 정보 수집이 어떻게 도는지. 값은 수집기 코드의 실제 값(수집기 /info/mechanism)과 표의 지금 상태(호스트별 오늘 쓴 예산·
 * 마지막 통과 계층·닫힘, 다음 실행 시각)입니다. 긴 표(호스트·태스크)는 10줄씩.
 */
export function MechanismSection() {
  const { data, loading, error, reload } = useApi<MechanismResponse>(endpoints.info.mechanism, 300_000);
  if (loading && !data) return <Loading label="작동 방식을 읽는 중…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;
  const c = data.collector;
  return (
    <div className="space-y-6">
      <FlowCard data={data} />
      {c ? (
        <>
          <SwitchCard c={c} />
          <PoliteCard c={c} alerts={data.alerts} />
          <HostsCard c={c} data={data} />
          <CadenceCard c={c} data={data} />
          <ArticlesCard c={c} />
        </>
      ) : (
        <Banner tone="warn">수집기에 닿지 못해 코드의 실제 값을 읽지 못했습니다(상태 확인 {data.checkedAt}). 아래 활용·보류 안내만 보입니다.</Banner>
      )}
      <PacketCard />
      <DeferredCard data={data} />
    </div>
  );
}

function FlowCard({ data }: { data: MechanismResponse }) {
  const steps = [
    ["1. 정기 실행", "수집기가 태스크마다 정해진 속도(5분·1시간·12시간, 장중 조건부)로 출처를 부릅니다. 차단 통과 수집은 따로 1분 남짓마다 깨어 '다음 실행 시각'이 지난 출처 하나씩만 돌립니다."],
    ["2. 받기", "공식 API는 키로 바로, 비공식 공개 경로는 보통 요청으로, 막는 출처는 브라우저처럼 보이는 요청(계층 1) → 실제 브라우저(계층 2, 운영 서버만) 순으로 시도합니다."],
    ["3. 저장", "받은 것은 저장본(snapshot)·관측치·글 표에 씁니다. 실패하면 직전 저장본을 버리지 않고 '이전 값'으로 이어받습니다."],
    ["4. 판정·알림", "출처마다 정상·차단·형식 바뀜·받지 못함을 기록하고, 끊기면 텔레그램(운영 봇)과 화면 위 안내 띠로 알립니다. 차단되면 그 출처는 잠시 멈춥니다."],
    ["5. 활용", "화면(매크로·레이더·KRX·모의매매)과 Claude 모의매매 패킷이 저장본만 읽습니다 — 화면을 열어도 수집이 일어나지 않습니다."],
  ];
  return (
    <Card title="한 바퀴" source={`상태 확인 ${data.checkedAt}`}>
      <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {steps.map(([title, body]) => (
          <li key={title} className="rounded-lg border border-border bg-surface-2 p-3">
            <p className="text-sm font-semibold text-text">{title}</p>
            <p className="mt-1 text-xs leading-5 text-text-2">{body}</p>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function OnOff({ on, yes, no }: { on: boolean | null; yes: string; no: string }) {
  if (on === null) return <StatusText tone="neutral">{EMPTY}</StatusText>;
  return <StatusText tone={on ? "ok" : "neutral"}>{on ? yes : no}</StatusText>;
}

function SwitchCard({ c }: { c: Collector }) {
  return (
    <Card title="스위치와 실행 장소" subtitle="차단 통과 수집은 운영 서버(Vultr)에서만 켭니다 — 이 PC의 IP로는 받지 않고, 프록시도 쓰지 않습니다.">
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Row label="차단 통과 수집(POLITE_FETCH_ENABLED)">
          <OnOff on={c.politeEnabled} yes="켬 — 이 수집기에서 돎" no="끔 — 이 수집기에서는 돌지 않음(로컬·QA)" />
        </Row>
        <Row label="깨어나는 간격">
          약 {formatNumber(c.tickSeconds, 0)}초 ± {formatNumber(c.tickJitterSeconds, 0)}초(한 번에 출처 하나)
        </Row>
        <Row label="한 번 실행의 시간 상한">{c.taskDeadlineSeconds === null ? EMPTY : `${formatNumber(c.taskDeadlineSeconds, 0)}초`}</Row>
        <Row label="브라우저 컨테이너(계층 2)">
          <OnOff on={c.browser.configured ? c.browser.reachable : false} yes="닿음" no={c.browser.configured ? "닿지 않음" : "없음(운영 서버에만 있음)"} />
        </Row>
        <Row label="사람 확인 체크박스">
          <OnOff on={c.browser.pressCheckbox} yes="누르기만 함(퍼즐·문자 입력은 하지 않음)" no="누르지 않음" />
        </Row>
        <Row label="브라우저를 쓸 수 있는 호스트">{c.browser.allowedHosts === null ? EMPTY : `${formatNumber(c.browser.allowedHosts, 0)}곳(쓰기 요청이 없는 곳만)`}</Row>
      </dl>
    </Card>
  );
}

function PoliteCard({ c, alerts }: { c: Collector; alerts: MechanismResponse["alerts"] }) {
  const backoff = c.backoffMinutes.map(([low, high], index) => `${index + 1}단계 ${minutesRange(low, high)}`).join(" → ");
  return (
    <Card title="사람 같은 간격·물러남·알림" subtitle="같은 시각에 되풀이되지 않게 모든 간격에 무작위를 섞습니다.">
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Row label="요청 사이 지연">
          보통 {formatNumber(c.gap.lowSeconds, 0)}~{formatNumber(c.gap.highSeconds, 0)}초(가운데 {formatNumber(c.gap.medianSeconds, 0)}초), {formatNumber(c.gap.longChance * 100, 0)}% 확률로{" "}
          {formatNumber(c.gap.longLowSeconds, 0)}~{formatNumber(c.gap.longHighSeconds, 0)}초 쉼
        </Row>
        <Row label="막히면 물러남">{backoff || EMPTY}</Row>
        <Row label="사람 확인 화면에 걸리면">{minutesRange(c.humanCheckMinutes[0], c.humanCheckMinutes[1])} 쉼(체크박스만 누르고, 넘어가지 못하면 물러남)</Row>
        <Row label="포기">
          물러남 {formatNumber(c.giveUpLevel, 0)}단계를 넘으면 그 호스트를 멈추고 {formatNumber(c.giveUpRecheckDays, 0)}일마다 한 번만 다시 봄
        </Row>
        <Row label="오래됨 표시">정한 간격의 {formatNumber(c.staleFactor, 0)}배가 지나도 새로 받지 못하면</Row>
        <Row label="끊김 알림(텔레그램 + 화면 띠)">
          차단은 바로, 형식 바뀜 연속 {formatNumber(alerts.formatStreak, 0)}회, 받지 못함 연속 {formatNumber(alerts.failedStreak, 0)}회 · {formatNumber(alerts.intervalMinutes, 0)}분마다 확인 · 다시 정상이 되면 풀림 알림
        </Row>
      </dl>
    </Card>
  );
}

function HostsCard({ c, data }: { c: Collector; data: MechanismResponse }) {
  const [page, setPage] = useState(1);
  const states = new Map(data.hostStates.map((row) => [row.host, row]));
  const rows: HostRow[] = c.hosts.map((host) => ({ ...host, state: states.get(host.host) ?? null }));
  const slice = pageSlice(rows, page, PAGE_SIZE);
  return (
    <Card title="호스트별 계층·하루 예산" subtitle="하루 예산은 그 호스트에 보내는 요청 수의 상한(KST 날짜 기준)입니다. 넘으면 다음 날까지 쉽니다.">
      <Table<HostRow>
        label="호스트별 계층·하루 예산"
        rows={slice.rows}
        rowKey={(row) => row.host}
        columns={[
          { key: "host", header: "호스트", render: (row) => <span className="font-mono text-xs">{row.host}</span> },
          { key: "tiers", header: "시도 계층", render: (row) => <span className="text-xs">{row.tiers.map(tierLabel).join(" → ")}</span> },
          {
            key: "budget",
            header: "오늘 / 하루 예산",
            align: "right",
            render: (row) => <span className="tabular-nums">{`${formatNumber(row.state?.usedToday ?? 0, 0)} / ${formatNumber(row.dailyBudget, 0)}`}</span>,
          },
          { key: "last", header: "마지막 통과", render: (row) => <span className="text-xs">{tierLabel(row.state?.lastGoodTier)}</span> },
          {
            key: "state",
            header: "상태",
            render: (row) => {
              const s = row.state;
              if (!s) return <StatusText tone="neutral">기록 없음</StatusText>;
              if (s.givenUp) return <StatusText tone="danger">포기 — 가끔 다시 봄</StatusText>;
              if (s.blockedUntil) return <StatusText tone="warn">{`쉬는 중 ~${s.blockedUntil}`}</StatusText>;
              return <StatusText tone="ok">{s.failLevel > 0 ? `열림(물러남 ${s.failLevel}단계 기억)` : "열림"}</StatusText>;
            },
          },
        ]}
      />
      <Pager page={slice.page} pages={slice.pages} onChange={setPage} label="호스트" />
    </Card>
  );
}

function CadenceCard({ c, data }: { c: Collector; data: MechanismResponse }) {
  const [page, setPage] = useState(1);
  const rows: CadenceRow[] = c.cadences.map((row) => ({ ...row, nextDue: data.schedule[row.task] ?? null }));
  const slice = pageSlice(rows, page, PAGE_SIZE);
  return (
    <Card title="출처별 간격·다음 실행" subtitle="실행할 때마다 다음 시각을 이 구간 안에서 무작위로 다시 뽑습니다(같은 시각에 되풀이되지 않음).">
      <Table<CadenceRow>
        label="출처별 간격"
        rows={slice.rows}
        rowKey={(row) => row.task}
        columns={[
          { key: "task", header: "태스크", render: (row) => <span className="font-mono text-xs">{row.task}</span> },
          { key: "range", header: "간격", render: (row) => minutesRange(row.lowMinutes, row.highMinutes) },
          { key: "next", header: "다음 실행", render: (row) => <span className="tabular-nums text-xs">{row.nextDue ?? EMPTY}</span> },
          { key: "note", header: "참고", render: (row) => <span className="text-xs text-text-2">{row.note ?? EMPTY}</span> },
        ]}
      />
      <Pager page={slice.page} pages={slice.pages} onChange={setPage} label="출처별 간격" />
    </Card>
  );
}

const ARTICLE_LABELS: Record<string, [string, string]> = {
  maxAgeDays: ["피드에서 받는 글", "일 이내"],
  pageMaxAgeDays: ["본문 페이지를 여는 글", "일 이내"],
  pageFetchesPerRun: ["한 번에 여는 본문 페이지", "쪽까지"],
  pageTriesPerItem: ["글 하나의 본문 시도", "회까지"],
  feedBodyMinChars: ["피드 본문을 '본문'으로 보는 길이", "자 이상"],
  waedgeBriefBodiesPerRun: ["waedge 시장 글 본문(한 번에)", "편까지"],
  waedgePeopleBodiesPerRun: ["waedge 거장 글 본문(한 번에)", "편까지"],
  bodyMaxChars: ["저장하는 본문 길이", "자까지"],
  summaryChars: ["요약 길이", "자"],
  retentionDays: ["글 보관", "일"],
};

function ArticlesCard({ c }: { c: Collector }) {
  return (
    <Card title="글 본문 규칙" subtitle="제목만이 아니라 본문까지 받습니다 — 피드에 본문이 있으면 그것을, 짧으면 글 페이지를 한 번에 몇 쪽씩만 엽니다.">
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
        {Object.entries(c.articles).map(([key, value]) => {
          const [label, unit] = ARTICLE_LABELS[key] ?? [key, ""];
          return (
            <Row key={key} label={label}>
              {formatNumber(value, 0)}
              {unit}
            </Row>
          );
        })}
      </dl>
    </Card>
  );
}

function PacketCard() {
  return (
    <Card title="수집한 정보의 활용" subtitle="수집 글은 Claude 모의매매 판단에 참고 자료로 들어갑니다(지시가 아니라 자료 — 구분자로 감싸고, 구분자처럼 보이는 글자는 지움).">
      <ul className="list-disc space-y-2 pl-5 text-sm leading-6 text-text-2">
        <li>
          <b className="text-text">패킷 섹션 11c_reading</b> — 결정 창(직전 결정 이후)에 쓰인 글 최대 8편(출처마다 2편, 본문을 다 받은 글 먼저)의 출처·시각·제목·앞부분
          240자. 미국은 해외 블로그·waedge 거장·waedge 해외 시장 글, 한국은 waedge 국내 시장 글. 첫 결정과 글이 없는 창에는 싣지 않습니다.
        </li>
        <li>
          <b className="text-text">스위치</b> — 미국 <code>info.packet</code>, 한국 <code>kr.info.packet</code>(기본 켬). 모의매매{" "}
          <Link href="/paper/us/settings" className="font-semibold hover:underline">
            설정 탭
          </Link>
          에서 시장별로 끄고 켭니다. 끄면 패킷은 이 섹션이 생기기 전과 바이트까지 같습니다.
        </li>
        <li>
          <b className="text-text">KRX 확정 순위</b> — 수급 레이더가 과거 날짜·여섯 투자주체 순위를 이 저장본에서 읽습니다(KIS → Daum → 네이버 → KRX 저장본 → 토스 순).
        </li>
        <li>
          <b className="text-text">사건 뉴스 RSS</b> — 미국·한국 사건 섹션(11b_events)에 쓰이고, 정보 수집의 뉴스·글 탭에서도 봅니다.
        </li>
      </ul>
    </Card>
  );
}

function DeferredCard({ data }: { data: MechanismResponse }) {
  if (data.deferred.length === 0) return null;
  return (
    <Card title="보류한 출처">
      <ul className="space-y-2 text-sm leading-6 text-text-2">
        {data.deferred.map((row) => (
          <li key={row.task}>
            <b className="text-text">{row.label}</b> — {row.reason}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-text-3">{label}</dt>
      <dd className="mt-0.5 text-text">{children}</dd>
    </div>
  );
}
