/*
  OP functions for ST-F1-13 (온보딩·튜토리얼). `onboarding-progress` is a REAL
  contract (스토리 스펙 §ST-B1-08, BE-1) — only its exact request/response shape
  is unconfirmed in this checkout, so the endpoint path itself is treated as
  real while the field names stay flexible (see `normalizeProgress`).

  W6 계약 정합(2026-08-28): 이 파일이 예전에 갖고 있던 캘린더 가져오기 한 쌍
  (`GET /onboarding/import-candidates` / `POST /onboarding/import-decisions`,
  ONB-09)은 계약에 없는 [가정-신규] 엔드포인트였다 — dev의 mock 폴백에 가려
  있다가 배포에서만 404로 드러났다. 캘린더 단계(OnboardingCalendarStep)가
  이제 `features/settings/settingsApi.js`의 실 계약 함수
  (`getExternalEvents`/`applyExternalEvent`, `/external-calendar-connections`
  계열)를 `CalendarConnectionSection` 재사용을 통해 그대로 쓰므로 이 파일에서는
  통째로 제거한다 — 같은 계약 호출이 두 벌 살아 있으면 한쪽만 고쳐질 위험이
  남는다.

  Reuses planApi's withDevFallback rather than redeclaring the one shared
  mock-fallback rule a fifth time (statsApi.js/settingsApi.js already made the
  same choice).
*/
import { apiClient } from '../../api/client'
import { withDevFallback } from '../plan/planApi'

/*
  onboardingFixtures.js를 최상단 정적 import로 들이지 않는다 — authApi.js의
  loadAuthMock()과 같은 이유(그 파일 헤더 참조): 정적 import는 번들러가 실행
  경로와 무관하게 항상 포함시켜, DEV 전용 mock 데이터가 프로덕션 청크에도
  그대로 실린다. `import.meta.env.DEV` 분기 안에서만 동적 import를 호출하면
  Vite가 빌드 시 그 값을 리터럴 false로 치환해 분기 전체가 도달 불가능해지고
  번들러가 통째로 제거한다.
*/
async function loadOnboardingMock() {
  if (!import.meta.env.DEV) return null
  const { onboardingMockBackend } = await import('./onboardingFixtures')
  return onboardingMockBackend
}

/*
  PROGRESS SHAPE (실서버 대조 2026-07-29 — OnboardingProgressResponse). The two
  sides model onboarding DIFFERENTLY, and the difference is the whole reason
  this adapter is more than casing tolerance:

    server: per-step DONE FLAGS — {introDone, profileDone, availabilityDone,
            fixedScheduleDone, tutorialDone, calendarSyncDone,
            tutorialSampleProjectId}
    here:   a CURSOR — {currentStep:'PROFILE'|…|'DONE', onboardingCompleted, …}

  The old adapter read none of the server's field names, so every real response
  normalized to the defaults: `currentStep:'PROFILE'`, `onboardingCompleted:
  false`. The wizard would have restarted from step 1 on every load and could
  never finish, no matter how many steps the server had recorded as done.

  The cursor is DERIVED as "the first step not yet done", in wizard order —
  which is exactly what the wizard's own forward-only stepping means. Fields
  the server has no column for (tutorialSkipped, tutorialStep) keep their local
  defaults: `tutorialDone` alone can't say whether the tutorial was completed
  or skipped, and the step index is a mock-only affordance. Both only affect
  DEV mock runs; against a real server the tutorial overlay reads
  `tutorialCompleted` and nothing else.
*/
const WIZARD_ORDER = [
  ['profileDone', 'PROFILE'],
  ['availabilityDone', 'AVAILABILITY'],
  ['fixedScheduleDone', 'FIXED'],
  ['calendarSyncDone', 'CALENDAR'],
]

const toSnake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

function currentStepFrom(p) {
  const found = WIZARD_ORDER.find(([flag]) => !(p[flag] ?? p[toSnake(flag)] ?? false))
  return found ? found[1] : 'DONE'
}

function normalizeProgress(p) {
  if (!p) return p
  const serverShaped = p.profileDone !== undefined || p.profile_done !== undefined
  const currentStep = p.currentStep ?? p.current_step ?? (serverShaped ? currentStepFrom(p) : 'PROFILE')
  return {
    onboardingCompleted:
      p.onboardingCompleted ?? p.onboarding_completed ?? (serverShaped ? currentStep === 'DONE' : false),
    introSeen: p.introSeen ?? p.intro_seen ?? p.introDone ?? p.intro_done ?? false,
    currentStep,
    // 서버 진행 레코드에는 프로필 값이 없다 — 프로필 자체는 /users/me가
    // 소유한다(ONB-02 저장도 그쪽으로 간다, updateOnboardingProgress 참고).
    profile: p.profile ?? null,
    tutorialCompleted: p.tutorialCompleted ?? p.tutorial_completed ?? p.tutorialDone ?? p.tutorial_done ?? false,
    tutorialSkipped: p.tutorialSkipped ?? p.tutorial_skipped ?? false,
    tutorialStep: p.tutorialStep ?? p.tutorial_step ?? 0,
    tutorialSampleProjectId: p.tutorialSampleProjectId ?? p.tutorial_sample_project_id ?? null,
    version: p.version ?? 1,
  }
}

/*
  The inverse: the wizard PATCHes a cursor ("이제 AVAILABILITY 단계다"), the
  server takes done-flags. Moving TO a step means the step BEFORE it is
  finished — exact here because the wizard advances exactly one step per click
  and never rewinds `currentStep` (see OnboardingWizardPage.advanceTo). A
  finishing patch (`onboardingCompleted`) sets every flag, so a resumed session
  can't land back inside the wizard on one straggling false.
*/
const STEP_COMPLETES = {
  AVAILABILITY: 'profileDone',
  FIXED: 'availabilityDone',
  CALENDAR: 'fixedScheduleDone',
  DONE: 'calendarSyncDone',
}

function progressFlagsFrom(patch) {
  const flags = {}
  if (patch.introSeen !== undefined) flags.introDone = patch.introSeen
  const completes = STEP_COMPLETES[patch.currentStep]
  if (completes) flags[completes] = true
  if (patch.onboardingCompleted) {
    for (const [flag] of WIZARD_ORDER) flags[flag] = true
  }
  // 서버는 완료와 건너뛰기를 구분하지 않는다 — 둘 다 tutorialDone이다.
  if (patch.tutorialCompleted !== undefined) flags.tutorialDone = patch.tutorialCompleted
  return flags
}

/** GET /users/me/onboarding-progress. */
export function getOnboardingProgress() {
  return withDevFallback(
    () => apiClient.get('/users/me/onboarding-progress'),
    async () => (await loadOnboardingMock()).getProgress(),
  ).then(normalizeProgress)
}

/**
 * PATCH /users/me/onboarding-progress. Callers keep sending the FE's own
 * cursor-shaped patch (`{ currentStep: 'AVAILABILITY' }` on step advance,
 * `{ profile }` on ONB-02 save); the translation to the server's done-flags
 * happens here (progressFlagsFrom).
 *
 * ONB-02's `profile` is NOT part of that record on a real server — the profile
 * lives on the user (PATCH /users/me/profile, the endpoint whose own summary
 * names ONB-02). Sending it inside the progress patch, as this used to, meant
 * the name/purpose the user typed was silently dropped by the server. So a
 * patch carrying a profile writes it there FIRST, and only then advances the
 * step: if the profile save fails, the wizard must not move on.
 */
export function updateOnboardingProgress(patch) {
  return withDevFallback(
    async () => {
      if (patch.profile) await apiClient.patch('/users/me/profile', patch.profile)
      return apiClient.patch('/users/me/onboarding-progress', progressFlagsFrom(patch))
    },
    // The mock store models the FE's own shape (profile included), so it keeps
    // receiving the untranslated patch.
    async () => (await loadOnboardingMock()).patchProgress(patch),
  ).then(normalizeProgress)
}
