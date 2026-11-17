/**
 * KPI 띠의 타일 하나. 값을 모르면 `value: null` — 0으로 채우지 않습니다.
 *
 * 형의 정본입니다(P5a 검토 — 화면 모델 lib/macroScreen·cotScreen·sectorScreen·liquidity·home이 같은 모양을 따로 적어 칸이 조용히 어긋났음). 공용 KPI 띠
 * (components/patterns KpiStrip)가 이 형을 다시 내보내고, 화면 모델은 이 형(필요하면 좁힌 교집합)을 씁니다. React를 모르는 순수 형입니다(ADR 0004).
 */
export type KpiItem = {
  key: string;
  /** 타일 이름 — 13px 보조 글, 타일 묶음(role=group)의 이름. */
  label: string;
  /** null·빈 글·"N/A"·NaN이면 "—"(Empty + emptyReason), 0은 값입니다. */
  value: string | number | null;
  /** 숫자 값 서식(없으면 소수 둘째 자리 — lib/patterns statValueText). */
  format?: (value: number) => string;
  /** 단위 — 값이 있을 때만(QA-049). */
  unit?: string | null;
  /** label: 판정 라벨(국면 등 — 숫자가 아님): tabular 없이 16px(lg 20px), 줄바꿈 허용. 기본 number. */
  valueKind?: "number" | "label";
  /** 판정 불가 같은 중립 값 — 중립 잉크(text-neutral). 뜻은 글이 나릅니다. */
  neutral?: boolean;
  /**
   * 변화 — 변화 칩(▲▼·부호·sr '상승/하락')과 12px 캡션('전일 대비'). 변화량·변화율을 둘 다 모르면 줄이 없습니다. `unit`은 변화량 바로 옆의 작은 단위
   * (공용 변화 칩의 unit — 금리차 '%p'·계약 등, 주지 않으면 단위 없음 — 홈 띠 그대로).
   */
  change?: { change?: number | null; changePct?: number | null; digits?: number; pctDigits?: number; caption?: string | null; unit?: string | null };
  /**
   * 상태 글 — 아이콘 + 글(공용 StatusText, 색만이 아님). `srPrefix`는 톤 기본 낭독 머리말(위험 '오류: '·주의 '주의: ') 대신 읽을 머리말 — 위험 톤이
   * 오류가 아니라 시장 상태(매크로 심화 지표 '깊은 역전' 등)일 때 '주의: '로(안내 상자 위험 톤과 같은 말). 주지 않으면 그대로.
   */
  status?: { tone: "ok" | "warn" | "danger"; text: string; srPrefix?: string };
  /** 12px 보조 글(기준일 등 — 값의 시각은 출처 줄의 `asOf`로). */
  note?: string | null;
  /**
   * 출처 줄(공용 출처 배지 — '출처 · 지연 · 시각', 원칙 '모든 숫자에 출처'): 이 넷 가운데 하나라도 주면 타일 아래에 늘 보입니다(숨기는 옵션 없음).
   * 비공식 참고 시세는 출처 글에 그 사실을 담아 넘깁니다(예 'TradingView Scanner · 참고 시세'). 지연은 장이 열려 있을 때의 시세 지연(분, 0이면 '실시간'),
   * `provenanceTitle`은 배지 툴팁(닫힌 장이라 적지 않은 지연 등). 앱 안에서 센 수(알림·오류 건수)처럼 바깥 출처가 없는 타일은 주지 않습니다.
   */
  source?: string | null;
  asOf?: string | null;
  delayMin?: number | null;
  provenanceTitle?: string | null;
  emptyReason?: string | null;
  /**
   * 읽는 중 — 값 자리에 Skeleton 한 줄(role=status '{label} 불러오는 중'). 이름 칸은 읽는 동안 읽어 주기에서 뺍니다(status 이름이 이름을 담음 —
   * 링크 타일의 이름이 '이름 + 이름 불러오는 중'으로 겹치지 않게, QA-597).
   */
  pending?: boolean;
  /**
   * 읽는 중 자리 줄 수(기본 0) — 값 자리표시 아래 같은 블록에 글 없는 막대(읽어 주기에서 뺌)를 이만큼 더 그려, 값이 온 뒤의 변화·배지·출처 줄 자리를
   * 미리 잡습니다(값이 와도 띠 높이가 크게 뛰지 않게 — QA-598). 한 줄의 칸은 가장 높은 타일까지 늘어나므로 가장 긴 타일에만 주면 됩니다.
   */
  pendingLines?: number;
  /**
   * 넓은 칸 배치의 자리 줄 수 — `pendingLines`보다 작으면 이 수 이상 순번의 덧 막대를 넓은 칸 배치(타일 198px 이상 — 띠 404px 이상인 두 칸, 세 칸 sm~lg,
   * 띠 816px 이상인 네 칸 — WIDE_PENDING)에서만 CSS로 감추고, 그 배치에서 보이는 마지막 막대를 짧게 합니다(DOM 막대 수는 그대로). 타일이 넓으면 출처 줄이
   * 덜 꺾여 읽은 뒤 타일이 낮기 때문입니다(QA-604). 주지 않으면 모든 배치에서 `pendingLines`.
   */
  pendingLinesWide?: number;
  isEstimated?: boolean;
  isProxy?: boolean;
  isStale?: boolean;
  staleReason?: string | null;
  /** 주면 타일 전체가 그 대상 화면 링크. */
  href?: string;
};
