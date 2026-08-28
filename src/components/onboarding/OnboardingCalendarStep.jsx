import { Button } from '../common/Button'
import { CalendarConnectionSection } from '../settings/CalendarConnectionSection'
import { onboardingCopy } from '../../features/onboarding/onboardingCopy'

/*
  ONB-07~09 (캘린더 3단계: 연동 → 캘린더 선택 → 반영). W6 계약 정합
  (2026-08-28, 오너 요청 "온보딩 캘린더 단계도 새 계약으로 고쳐줘"): 이전엔
  이 단계가 계약에 없는 `/onboarding/import-candidates`·`/onboarding/
  import-decisions`(mode: 'EXCLUDED')를 직접 불렀다 — dev에서는 404가 mock
  폴백에 가려 안 드러났지만 배포에는 그 폴백이 없어 오류 블록으로 그대로
  노출됐다(온보딩은 처음 들어온 사람이 걷는 경로라 더 치명적).

  세 단계(연동·캘린더 선택·반영) 전부를 이 파일이 직접 구현하지 않는다 —
  `CalendarConnectionSection`(설정 화면 FIX-13~17이 이미 실 계약
  `/external-calendar-connections`로 구현해 둔 컴포넌트)이 연동 Toggle,
  캘린더 선택 다이얼로그, "일정 가져와 반영" 버튼(useApplyCandidateEvents —
  조회=동기화와 반영을 한 동작으로 묶음, 그 훅 자신의 헤더 참조)까지 이미
  전부 갖추고 있어 그대로 재사용한다. 두 화면이 같은 연동 상태를 공유하므로
  같은 컴포넌트를 두 벌 유지하지 않는다.

  이 단계 자체가 온보딩 4단계 중 유일하게 [나중에 하기] 종료가 있다(AC2) —
  외부 캘린더 연동은 선택 사항이라, 연동/반영 여부와 무관하게 두 버튼 모두
  항상 눌러 다음(완료)으로 넘어갈 수 있다.
*/
export function OnboardingCalendarStep({ onFinish, onBack, finishing }) {
  const c = onboardingCopy.calendar

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-title font-semibold text-text">{c.heading}</h2>
        <p className="mt-1 text-label text-text-muted">{c.body}</p>
      </div>

      <CalendarConnectionSection />

      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="secondary" size="md" onClick={onBack}>
          {onboardingCopy.wizard.back}
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" size="md" onClick={onFinish} disabled={finishing}>
            {onboardingCopy.wizard.later}
          </Button>
          <Button type="button" variant="primary" size="md" onClick={onFinish} loading={finishing}>
            {onboardingCopy.wizard.finish}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default OnboardingCalendarStep
