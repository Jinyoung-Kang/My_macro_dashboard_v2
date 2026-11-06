"use client";

import { Button } from "@/components/ui";
import { enableBlock, showDisable } from "@/lib/realtrade";
import { useRealTrade } from "./RealTradeProvider";

/**
 * 실제 매매 켜기·끄기 단추(ADR 0028, 명세 §8) — 실제 매매 칸 머리와 실제 계좌 요약 '다시 읽기' 옆(PaperScreen이 BrokerageSection의 extraActions로 넘김)에
 * 같은 단추를 둡니다. 둘 다 RealTradeProvider의 같은 상태·같은 동작을 씁니다.
 *
 * <ul>
 *   <li>끄기: 확인 창 없이 바로 POST /api/realtrade/disable. 켜짐·멈춤·끄는 중이면 늘 보이고, 상태를 모를 때도 보입니다(lib/realtrade `showDisable`) —
 *       첫 읽기 중, 읽기 실패 뒤 다시 읽는 중에도(RT2-FE-1 — 끄기는 어느 상태에서도 서버가 받으므로 모르면 보이는 쪽이 안전).</li>
 *   <li>켜기: 꺼짐을 확실히 읽었을 때만(마지막 읽기가 성공) — 켜기 창(확인 글자 + 비밀번호)을 엽니다. 서버 스위치가 꺼져 있으면 꺼진 단추입니다.</li>
 *   <li>미국: 준비 중이라 꺼진 켜기 단추 하나.</li>
 * </ul>
 */
export function RealTradeToggle() {
  const rt = useRealTrade();
  if (!rt) {
    return null;
  }
  if (!rt.supported) {
    return (
      <Button size="sm" disabled>
        실제 매매 켜기(준비 중)
      </Button>
    );
  }
  const offVisible = showDisable(rt.status, rt.readFailed);
  const onVisible = !rt.readFailed && rt.status?.available === true && rt.status.state === "OFF";
  const block = enableBlock(rt.status);

  return (
    <>
      {onVisible && (
        <Button size="sm" variant="primary" disabled={block !== null || rt.disableBusy} onClick={() => rt.openDialog("enable")}>
          실제 매매 켜기
        </Button>
      )}
      {offVisible && (
        <Button size="sm" variant="danger" disabled={rt.disableBusy} onClick={() => void rt.disable()}>
          {rt.disableBusy ? "끄는 중…" : "실제 매매 끄기"}
        </Button>
      )}
    </>
  );
}
