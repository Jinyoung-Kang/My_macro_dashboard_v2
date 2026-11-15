import { AuthCard } from "@/components/auth/AuthCard";

/**
 * 개인정보 수집·이용 안내 — 가입 동의의 근거(명세 B10). 대시보드가 실제로 저장하는 것만 적습니다.
 * 유료 서비스로 공개하기 전에는 법률 검토를 거친 처리방침으로 바꿔야 합니다(명세 §5).
 */
export default function PrivacyPage() {
  const rows = [
    ["수집 항목", "이메일, 비밀번호(Argon2id 해시 — 원문은 저장하지 않음), 가입·인증 시각, 등급, 알림 규칙·관심 목록, 로그인 기기 정보(브라우저 이름 앞부분)"],
    ["수집하지 않는 것", "접속 IP(로그인 지연 판정에 메모리로만 쓰고 저장하지 않음), 결제 정보"],
    ["이용 목적", "로그인, 가입 확인·비밀번호 재설정 메일, 등급별 기능 제공, 보안 감사 기록"],
    ["보관 기간", "계정을 지울 때까지. 계정을 지우면 이메일·세션·알림 설정을 바로 지우고, 보안 감사 기록은 사용자 식별자를 뗀 채 남깁니다"],
    ["제3자 제공", "없음. 메일은 운영자가 설정한 메일 서버(SMTP)로 보냅니다"],
  ];
  return (
    <AuthCard title="개인정보 수집·이용 안내">
      <dl className="mt-3 flex flex-col gap-3 text-xs">
        {rows.map(([term, detail]) => (
          <div key={term}>
            <dt className="font-semibold text-text">{term}</dt>
            <dd className="mt-0.5 leading-relaxed text-text-2">{detail}</dd>
          </div>
        ))}
      </dl>
    </AuthCard>
  );
}
