import PaperScreen from "@/components/screens/paper/PaperScreen";

/** 🧪 모의 알고리즘 매매(한국) 개요(/paper/kr, 운영자 전용, 2단계 명세 §4-16) — 라우트는 얇게, 그리기는 components/screens/paper. */
export default function PaperKrPage() {
  return <PaperScreen initialTab="overview" market="KR" />;
}
