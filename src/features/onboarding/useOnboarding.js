/*
  TanStack Query wiring for ST-F1-13. Server state (the onboarding-progress
  document) only — the wizard/tutorial's own in-progress edits (profile form
  fields) stay in page-local state until submitted, same server/draft split
  every other feature follows (design-handoff §3).

  W6 계약 정합(2026-08-28): 캘린더 가져오기 훅(useImportCandidates/
  useSubmitImportDecisions)을 여기서 제거했다 — 그 둘이 부르던 API가 계약에
  없는 엔드포인트였다(onboardingApi.js 헤더 참조). 캘린더 단계는 이제
  `features/settings/useSettings.js`의 실 계약 훅(useApplyCandidateEvents 등)을
  CalendarConnectionSection 재사용을 통해 그대로 쓴다.
*/
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getOnboardingProgress, updateOnboardingProgress } from './onboardingApi'
import { toast } from '../../hooks/useToasts'
import { systemMessages } from '../../constants/systemMessages'

export const onboardingProgressKey = () => ['onboardingProgress']

export function useOnboardingProgress() {
  return useQuery({ queryKey: onboardingProgressKey(), queryFn: getOnboardingProgress })
}

/**
 * Every step-advance/profile-save/tutorial-progress write goes through this
 * one mutation. `onSuccess` writes the server's own returned document back
 * into the cache (never a locally-guessed merge) — the source of truth for
 * "where was the user" (AC2) must always be what the server just confirmed.
 */
export function useUpdateOnboardingProgress() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: updateOnboardingProgress,
    onSuccess: (data) => queryClient.setQueryData(onboardingProgressKey(), data),
    onError: () => toast({ tone: 'error', message: systemMessages.error.writeTitle }),
  })
}
