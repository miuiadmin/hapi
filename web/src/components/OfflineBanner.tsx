import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { useTranslation } from '@/lib/use-translation'

export function OfflineBanner({ sseConnected }: { sseConnected: boolean }) {
    const { t } = useTranslation()
    const isOnline = useOnlineStatus()

    // navigator.onLine can report offline while the hub is still reachable
    // (e.g. Telegram WebView), so only show when the SSE stream is down too
    if (isOnline || sseConnected) {
        return null
    }

    return (
        <div className="fixed top-0 left-0 right-0 bg-amber-500 text-white text-center pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] text-sm font-medium z-50">
            {t('offline.message')}
        </div>
    )
}
