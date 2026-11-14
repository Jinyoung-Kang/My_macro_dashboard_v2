"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { linkGraphLayout, linkGraphSize, linkTarget, type LinkGraphNode, type LinkGroup, type SearchTarget } from "@/lib/infoSearch";
import { LINK } from "./parts";

/** 그림 아래에 늘 적는 한 줄(계약 §9-3). */
const GRAPH_NOTE = "받은 자료 기준 — 출처에 없는 관계는 그리지 않음";

/**
 * 연결 그림(계약 §9-3) — 대상을 가운데, 관계 묶음마다 둘레의 부채꼴에 노드(최대 30 — 넘으면 '목록에서 n개 더'), 가운데에서 노드로 가는 선과
 * 이어진 호마다 관계 글(한국어 — 묶음이 좌우 호로 쪼개지면 양쪽에). 새 의존성 없이 SVG로 그리고, 배치는 lib의 순수 함수(linkGraphLayout)가 정합니다(명세 A10).
 *
 * 그림의 폭은 담는 칸의 폭을 재서 맞추고(좁은 화면 390에서도 — 글자 12px이 줄지 않게 뷰박스를 칸 폭과 같게), 재지 못하면 360으로 그려 칸에 맞춰
 * 줄입니다. 노드는 Tab으로 차례로 닿고(낭독 이름 = 이름 · 관계), 누르기·Enter·Space로 그 대상으로(키가 없으면 그 이름으로 찾기) 갑니다.
 * 노드는 누를 수 있는 것이라 강조 파랑(이름·테두리), 선·관계 글은 데이터라 중립입니다(명세 A1). 포커스는 노드를 둘러싼 2px 고리로 보입니다
 * (브라우저 기본 바깥선은 투명 — 고대비 모드에서는 시스템 색으로 보임).
 * 색은 currentColor로 칠해 고대비 모드에서도 시스템 글자색으로 남습니다.
 */
export function LinksGraph({
  groups,
  centerName,
  onTarget,
  onShowList,
}: {
  groups: readonly LinkGroup[];
  centerName: string;
  onTarget: (target: SearchTarget) => void;
  onShowList: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(0);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => setMeasured(box.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  const size = useMemo(() => linkGraphSize(measured), [measured]);
  const layout = useMemo(() => linkGraphLayout(groups, size, { centerName }), [groups, size, centerName]);
  const { center } = layout;

  const open = (node: LinkGraphNode) => onTarget(linkTarget(node.link));
  const onKeyDown = (event: KeyboardEvent<SVGGElement>, node: LinkGraphNode) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    open(node);
  };

  return (
    <div className="flex flex-col gap-2">
      <div ref={boxRef} className="w-full">
        <svg
          role="group"
          aria-label={`${centerName}의 연결 그림 — 노드 ${layout.nodes.length}개`}
          width="100%"
          viewBox={`0 ${layout.view.y} ${layout.width} ${layout.view.height}`}
          className="block h-auto max-w-full"
        >
          <g aria-hidden="true" className="text-border-strong">
            {layout.nodes.map((node) => (
              <line key={node.id} x1={layout.cx} y1={layout.cy} x2={node.x} y2={node.y} stroke="currentColor" strokeWidth={1} />
            ))}
          </g>
          <g aria-hidden="true" className="text-text-3">
            {layout.tags.map((tag) => (
              <g key={`${tag.relation}:${tag.side}`}>
                <rect x={tag.x - tag.width / 2 - 4} y={tag.y - 8} width={tag.width + 8} height={16} rx={2} fill="var(--surface)" />
                <text x={tag.x} y={tag.y + 4} textAnchor="middle" fontSize={12} fill="currentColor">
                  {tag.label}
                </text>
              </g>
            ))}
          </g>
          <g aria-hidden="true" className="text-text">
            <rect
              x={layout.cx - center.width / 2}
              y={layout.cy - center.height / 2}
              width={center.width}
              height={center.height}
              rx={4}
              fill="var(--surface-2)"
              stroke="currentColor"
              strokeOpacity={0.6}
            />
            <text x={layout.cx} y={layout.cy + 4} textAnchor="middle" fontSize={12} fontWeight={600} fill="currentColor">
              {center.label}
            </text>
          </g>
          {layout.nodes.map((node) => (
            <g
              key={node.id}
              role="button"
              tabIndex={0}
              aria-label={node.ariaLabel}
              onClick={() => open(node)}
              onKeyDown={(event) => onKeyDown(event, node)}
              className="group/node cursor-pointer text-accent outline-hidden hover:text-accent-hover"
            >
              {/* 마우스로 가리키면 이름·관계(줄인 이름의 전체 — 낭독 이름과 같은 글). */}
              <title>{node.ariaLabel}</title>
              {/* 누르는 자리를 넓히는 투명 원(어느 이웃 노드의 원과도 겹치지 않는 만큼, 많아야 지름 44) — 그리기는 아래 작은 원. 이름 글자도 누르는 자리입니다. */}
              <circle cx={node.x} cy={node.y} r={layout.hitRadius} fill="transparent" />
              <circle
                cx={node.x}
                cy={node.y}
                r={11}
                fill="none"
                stroke="var(--focus)"
                strokeWidth={2}
                className="opacity-0 group-focus-visible/node:opacity-100"
              />
              <circle cx={node.x} cy={node.y} r={5} fill="var(--surface-2)" stroke="currentColor" strokeWidth={2} />
              <text x={node.labelX} y={node.labelY} textAnchor={node.anchor} fontSize={12} fill="currentColor">
                {node.label}
              </text>
            </g>
          ))}
        </svg>
      </div>
      {layout.hidden > 0 ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-2">
          <span>그림에는 {layout.nodes.length}개만 그렸습니다(관계마다 돌아가며 고름).</span>
          <button type="button" onClick={onShowList} className={LINK}>
            목록에서 {layout.hidden}개 더
          </button>
        </p>
      ) : null}
      <p className="text-xs text-text-3">{GRAPH_NOTE}</p>
    </div>
  );
}
