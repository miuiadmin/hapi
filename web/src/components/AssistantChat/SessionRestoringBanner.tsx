import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/lib/use-translation'

/**
 * Floating "restoring" banner of the conversation view: shown while the hub
 * resumes the session (a Reopen, or a send to a stopped session). It floats
 * over the top centre of the thread, so it moves nothing, takes no focus, and
 * leaves by itself when the hub answers. Coloured like the app's banners.
 */
export function SessionRestoringBanner() {
    const { t } = useTranslation()
    return (
        <div
            data-testid="session-restoring-banner"
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute left-1/2 top-2 z-30 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full bg-[var(--app-banner-bg)] px-3 py-1.5 text-xs font-medium text-[var(--app-banner-text)] shadow-lg"
        >
            <Spinner size="sm" label={null} className="text-[#34C759]" />
            {t('session.restoring')}
        </div>
    )
}
