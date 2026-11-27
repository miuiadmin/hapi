import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useTranslation } from '@/lib/use-translation'

type ArchiveSessionDialogProps = {
    isOpen: boolean
    onClose: () => void
    sessionId: string
    sessionName: string
    active: boolean
    onConfirm: () => Promise<void>
    isPending: boolean
}

export function ArchiveSessionDialog(props: ArchiveSessionDialogProps) {
    const { t } = useTranslation()
    // Inactive SSE can arrive before the archive request has finished its
    // process checks. It is progress, not proof that cleanup succeeded.
    const confirmingCleanup = props.isPending && !props.active
    return (
        <ConfirmDialog
            isOpen={props.isOpen}
            onClose={props.onClose}
            title={t('dialog.archive.title')}
            description={confirmingCleanup
                ? t('dialog.archive.cleanupDescription')
                : props.isPending
                    ? t('dialog.archive.pendingDescription')
                    : t('dialog.archive.description', { name: props.sessionName })}
            confirmLabel={t('dialog.archive.confirm')}
            confirmingLabel={t(confirmingCleanup ? 'dialog.archive.cleaning' : 'dialog.archive.confirming')}
            // The row looked archived from the click on. When the request fails
            // the mutation reports it to the app's failure dialog
            // (SessionActionErrorDialog), whether or not this window is still
            // open; so this window simply closes, and never toasts.
            onConfirm={() => props.onConfirm().catch(() => undefined)}
            isPending={props.isPending}
            allowDismissWhilePending
            destructive
            centerTitle
        />
    )
}
