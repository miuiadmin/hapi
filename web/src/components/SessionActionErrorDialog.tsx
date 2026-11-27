import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { dismissSessionActionFailure, useSessionActionFailure } from '@/lib/sessionActionFailures'
import { useTranslation } from '@/lib/use-translation'

/**
 * The one modal that says an archive or a reopen failed. Archiving shows its
 * result at once and a reopen shows progress, so the failure is the only
 * thing the operator must still hear about, and it is a dialog rather than a
 * toast because the row that started the action is not the thing that reports
 * it. Mounted once, at the app root next to the toasts.
 */
export function SessionActionErrorDialog() {
    const failure = useSessionActionFailure()
    const { t } = useTranslation()
    if (!failure) return null
    const close = () => dismissSessionActionFailure(failure)
    return (
        <ConfirmDialog
            isOpen={true}
            onClose={close}
            title={failure.kind === 'archive' ? t('dialog.archive.error') : t('dialog.reopen.errorTitle')}
            description={failure.message ?? t('dialog.error.default')}
            confirmLabel={t('button.close')}
            confirmingLabel={t('button.close')}
            onConfirm={async () => dismissSessionActionFailure(failure)}
            isPending={false}
            hideCancel
            centerTitle
        />
    )
}
