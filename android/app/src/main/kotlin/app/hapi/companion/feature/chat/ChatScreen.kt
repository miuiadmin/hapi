package app.hapi.companion.feature.chat

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import app.hapi.companion.R
import app.hapi.companion.feature.agentterminal.AgentTerminalPanel
import app.hapi.companion.feature.agentterminal.AgentTerminalViewModel
import app.hapi.companion.feature.chat.composer.DictationErrorKind
import app.hapi.companion.feature.chat.attachments.AttachmentPickerSheet
import app.hapi.companion.feature.chat.attachments.AttachmentPreparer
import app.hapi.companion.feature.chat.attachments.CameraCapture
import app.hapi.companion.feature.chat.attachments.ClipboardAttachments
import app.hapi.companion.feature.chat.attachments.ClipboardClipItem
import app.hapi.companion.feature.chat.attachments.PrepareResult
import app.hapi.companion.feature.chat.composer.ChatComposer
import app.hapi.companion.feature.chat.composer.DictationController
import app.hapi.companion.feature.chat.composer.DictationEvent
import app.hapi.companion.feature.chat.composer.DictationState
import app.hapi.companion.feature.chat.composer.QueuedMessagesBar
import app.hapi.companion.feature.chat.composer.parkDraftEligible
import app.hapi.companion.feature.chat.share.ShareTurnDialog
import app.hapi.companion.feature.files.FolderGlyph
import app.hapi.companion.feature.sessions.DeleteSessionDialog
import app.hapi.companion.feature.sessions.CursorReopenGateReason
import app.hapi.companion.feature.sessions.RenameSessionDialog
import app.hapi.companion.feature.sessions.SessionExportDialog
import app.hapi.companion.feature.sessions.SessionExportSupport
import app.hapi.companion.ui.markdown.LocalMarkdownRenderCache
import app.hapi.companion.ui.markdown.LocalMarkdownLinkHandler
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.ConversationOutlineItem
import app.hapi.protocol.chat.VisibleChatBlock
import app.hapi.protocol.chat.buildMessageMetadataLabels
import app.hapi.protocol.chat.messageMetadataForBlock
import java.io.File
import kotlinx.coroutines.launch

/** Pending camera capture across rotation/process death: uri + scratch path. */
private val CameraCaptureSaver = listSaver<CameraCapture?, String>(
    save = { capture ->
        if (capture == null) emptyList() else listOf(capture.uri.toString(), capture.file.absolutePath)
    },
    restore = { saved ->
        if (saved.size < 2) null else CameraCapture(Uri.parse(saved[0]), File(saved[1]))
    },
)

/** Conversation destination. ChatHost owns the shared session and reader navigation. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ChatScreen(
    viewModel: ChatViewModel,
    media: ChatMedia,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    snackbarHostState: SnackbarHostState = remember { SnackbarHostState() },
    /** null ⇒ mic button hidden (tests / previews without a controller). */
    dictation: DictationController? = null,
    /** Top-bar folder icon → session files browser (B-M4c). */
    onOpenFiles: () -> Unit = {},
    /** Markdown file citations → file viewer (full mode; optional line hint). */
    onOpenFile: (path: String, line: Int?) -> Unit = { _, _ -> },
    /** Markdown session citations → push that session's chat (web SessionPathAnchor parity). */
    onOpenSession: (String) -> Unit = {},
    /** null ⇒ no scratchlist top-bar entry (tests / previews). */
    onOpenScratchlist: (() -> Unit)? = null,
    /** null ⇒ no export entry in the overflow menu (tests / previews). */
    sessionExport: SessionExportSupport? = null,
    /** null ⇒ no terminal overflow entry (tests / previews). */
    onOpenTerminal: (() -> Unit)? = null,
    /**
     * Agent PTY panel: null ⇒ no entry and no panel (tests / previews).
     * Entry additionally needs header.active + header.agentPty
     * (web `canViewAgentTerminal`); the panel re-checks and shows reasons.
     */
    agentTerminal: AgentTerminalViewModel? = null,
    transcriptList: androidx.compose.foundation.lazy.LazyListState = androidx.compose.foundation.lazy.rememberLazyListState(),
    readingState: TranscriptReadingState = rememberTranscriptReadingState(viewModel.sessionId),
) {
    val state by viewModel.uiState.collectAsState()
    val reconnecting by viewModel.reconnecting.collectAsState()
    val historyPaging by viewModel.historyPaging.collectAsState()
    val jumpToken by viewModel.jumpToken.collectAsState()
    val jumpingLatest by viewModel.jumpingLatest.collectAsState()
    val composerState by viewModel.composer.collectAsState()
    val pendingSchedule by viewModel.pendingSchedule.collectAsState()
    val codexPlanActions by viewModel.codexPlanActions.collectAsState()
    val queuedRows by viewModel.queuedRows.collectAsState()
    val reopenCard by viewModel.reopenCard.collectAsState()
    val configState by viewModel.config.collectAsState()
    // Feeds the delete dialog's scratchlist count hint (web
    // `useScratchlistCount`, shared by the same store state).
    val scratchlistCount by viewModel.scratchlistCount.collectAsState()
    val cursorReopenGate by viewModel.cursorReopenGate.collectAsState()
    val cursorMigrationBanner by viewModel.cursorMigrationBanner.collectAsState()
    // Web `resolveCursorReopenGate` text mapping: the definitive-missing and
    // checking reasons disable the affordances; a probe error keeps them
    // enabled with the unverified hint (#1084).
    val reopenDisabledReason = when (cursorReopenGate.disabledReason) {
        CursorReopenGateReason.Missing -> stringResource(R.string.sessions_reopen_cursor_missing)
        CursorReopenGateReason.Checking -> stringResource(R.string.sessions_reopen_cursor_checking)
        null -> null
    }
    val reopenHint =
        if (cursorReopenGate.probeUnverified) stringResource(R.string.sessions_reopen_cursor_unverified) else null
    val toolbarHeight = maxOf(64.dp, with(LocalDensity.current) { 24.sp.toDp() + 16.sp.toDp() } + 16.dp)
    var configSheetOpen by remember { mutableStateOf(false) }
    var renameDialogOpen by remember { mutableStateOf(false) }
    var deleteDialogOpen by remember { mutableStateOf(false) }
    var exportDialogOpen by remember { mutableStateOf(false) }
    // Web terminalVisible (SessionChat state): survives rotation, resets on a
    // fresh app entry like the web's per-mount useState.
    var agentTerminalVisible by rememberSaveable { mutableStateOf(false) }
    var outlineSheetOpen by remember { mutableStateOf(false) }
    var messageInfoBlock by remember { mutableStateOf<VisibleChatBlock?>(null) }
    var shareTurnBlock by remember { mutableStateOf<VisibleChatBlock?>(null) }

    DisposableEffect(viewModel) {
        viewModel.setTranscriptVisible(true)
        onDispose { viewModel.setTranscriptVisible(false) }
    }

    val context = LocalContext.current
    // ------------------------------------------------------------ dictation --
    val dictationState = dictation?.state?.collectAsState()?.value ?: DictationState.Idle
    val dictationAvailable = dictation?.isAvailable?.collectAsState()?.value ?: false
    LaunchedEffect(dictation) {
        dictation?.refreshAvailability()
    }
    LaunchedEffect(dictation, context) {
        dictation?.events?.collect { event ->
            when (event) {
                is DictationEvent.Transcribed -> viewModel.appendDictatedText(event.text)
                DictationEvent.NoProvider -> snackbarHostState.showSnackbar(
                    context.getString(R.string.chat_notice_no_transcription),
                )
                is DictationEvent.Error -> snackbarHostState.showSnackbar(
                    event.detail ?: context.getString(
                        when (event.kind) {
                            DictationErrorKind.StartFailed -> R.string.chat_dictation_start_failed
                            DictationErrorKind.HubUnreachable -> R.string.chat_dictation_hub_unreachable
                            DictationErrorKind.RecordingFailed -> R.string.chat_dictation_recording_failed
                            DictationErrorKind.NoAudio -> R.string.chat_dictation_no_audio
                            DictationErrorKind.TranscriptionFailed -> R.string.chat_dictation_failed
                        },
                    ),
                )
            }
        }
    }
    val scope = rememberCoroutineScope()
    val micPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            dictation?.toggle()
        } else {
            scope.launch {
                snackbarHostState.showSnackbar(context.getString(R.string.chat_notice_mic_permission))
            }
        }
    }
    val onDictationToggle: () -> Unit = toggle@{
        val controller = dictation ?: return@toggle
        // Stopping never needs the permission; starting checks + requests it.
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        when {
            dictationState !is DictationState.Idle -> controller.toggle()
            granted -> controller.toggle()
            else -> micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }
    val slashSuggestions by viewModel.slashSuggestions.collectAsState()
    val skillSuggestions by viewModel.skillSuggestions.collectAsState()
    val mentionSuggestions by viewModel.mentionSuggestions.collectAsState()

    // --------------------------------------------------------- attachments --
    val attachmentItems by viewModel.attachments.items.collectAsState()
    var attachmentSheetOpen by remember { mutableStateOf(false) }
    val preparer = remember { AttachmentPreparer(context) }

    /** Read + policy-apply one pick, then hand it to the upload tray. */
    suspend fun ingestUri(uri: Uri) {
        when (val result = preparer.prepare(uri)) {
            is PrepareResult.Ready -> viewModel.attachments.add(result.attachment)
            is PrepareResult.TooLarge -> snackbarHostState.showSnackbar(
                context.getString(R.string.chat_notice_attachment_too_large, result.filename),
            )
            is PrepareResult.Unreadable -> snackbarHostState.showSnackbar(
                context.getString(R.string.chat_notice_attachment_unreadable, result.filename),
            )
        }
    }

    fun ingestUris(uris: List<Uri>) {
        if (uris.isEmpty()) return
        scope.launch { uris.forEach { ingestUri(it) } }
    }

    // Paste-to-attach: the framework clipboard service, because another
    // app's content-URI grants travel via ClipData and Compose's
    // ClipboardManager is text-only.
    val clipboardManager = remember { context.getSystemService(ClipboardManager::class.java) }

    /** Attachable content URIs on [clip] (empty ⇒ fall through to text paste). */
    fun clipboardAttachableUris(clip: ClipData?): List<Uri> {
        if (clip == null) return emptyList()
        val items = (0 until clip.itemCount).map { ClipboardClipItem(clip.getItemAt(it).uri?.toString()) }
        return ClipboardAttachments.attachableUris(items).map(Uri::parse)
    }

    // Ctrl/Cmd+V in the composer: attach clipboard files when present, else
    // report false so the default text paste runs (web handlePaste semantics).
    val pasteFromClipboard: () -> Boolean = {
        val uris = clipboardAttachableUris(clipboardManager.primaryClip)
        if (uris.isEmpty()) false else {
            ingestUris(uris)
            true
        }
    }

    // Clipboard row state for the "+" sheet — read when it opens (user tap,
    // satisfying the Android 10+ focused-app clipboard rule).
    var clipboardPick by remember { mutableStateOf<Pair<String?, List<Uri>>?>(null) }
    LaunchedEffect(attachmentSheetOpen) {
        if (attachmentSheetOpen) {
            clipboardPick = clipboardManager.primaryClip?.let { clip ->
                val uris = clipboardAttachableUris(clip)
                if (uris.isEmpty()) {
                    null
                } else {
                    val label = clip.description.label?.toString()
                        ?: if (clip.description.mimeTypeCount > 0) clip.description.getMimeType(0) else null
                    label to uris
                }
            }
        }
    }

    val photoPickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(),
    ) { uris -> ingestUris(uris) }
    val documentPickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris -> ingestUris(uris) }

    // The camera app may rotate/kill us while open — keep the scratch target.
    var pendingCapture by rememberSaveable(stateSaver = CameraCaptureSaver) {
        mutableStateOf<CameraCapture?>(null)
    }
    val takePictureLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicture(),
    ) { success ->
        val capture = pendingCapture
        pendingCapture = null
        if (capture == null) return@rememberLauncherForActivityResult
        if (!success) {
            capture.discard()
            return@rememberLauncherForActivityResult
        }
        scope.launch {
            ingestUri(capture.uri)
            capture.discard()
        }
    }

    fun launchCamera() {
        val capture = preparer.newCameraCapture()
        pendingCapture = capture
        takePictureLauncher.launch(capture.uri)
    }

    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            launchCamera()
        } else {
            scope.launch {
                snackbarHostState.showSnackbar(context.getString(R.string.chat_notice_camera_permission))
            }
        }
    }
    val onTakePhoto: () -> Unit = {
        // The manifest declares CAMERA (QR pairing), which makes the runtime
        // grant mandatory for ACTION_IMAGE_CAPTURE too.
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) launchCamera() else cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
    }

    val interactions = remember(state.flavor, state.permissionOverrides, codexPlanActions, state.historyGate, viewModel) {
        ChatInteractions(
            flavor = state.flavor,
            permissionOverrides = state.permissionOverrides,
            resolvePermission = viewModel::resolvePermission,
            retryFailedMessage = viewModel::retryFailedMessage,
            codexPlanActions = codexPlanActions,
            implementCodexPlan = viewModel::implementCodexPlan,
            continueCodexPlan = viewModel::continueCodexPlan,
            historyGate = state.historyGate,
            requestForkCurrent = viewModel::requestForkCurrent,
            requestForkAtMessage = viewModel::requestForkAtMessage,
            requestRewind = viewModel::requestRewind,
        )
    }

    /**
     * Reveal an outline entry's message in the transcript. Detaching from
     * the tail comes first — the follow-tail correction would otherwise
     * snap the list straight back to the newest message. The list keeps a
     * fixed header row at index 0, hence the +1; each outline entry targets
     * a block id the transcript rows are keyed by, so the lookup cannot
     * drift between the panel and the list.
     */
    val onOutlineSelect: (ConversationOutlineItem) -> Unit = { item ->
        outlineSheetOpen = false
        readingState.followsTail = false
        val rowIndex = state.blocks.indexOfFirst { it.stableId == item.targetBlockId }
        if (rowIndex >= 0) {
            scope.launch { transcriptList.scrollToItem(rowIndex + 1) }
        }
    }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                expandedHeight = toolbarHeight,
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.chat_back))
                    }
                },
                title = { ChatTitle(state.header, reconnecting, viewModel::retry) },
                actions = {
                    // Two icons max (device feedback: four icons squeezed the
                    // title out) — gear for the frequent config switches,
                    // destructive/session-scoped actions in the overflow menu.
                    // Files/Scratchlist/Park moved to the composer action row
                    // (they are draft-level, not session-level, actions).
                    IconButton(onClick = { configSheetOpen = true }) {
                        Icon(Icons.Filled.Settings, contentDescription = stringResource(R.string.chat_open_settings))
                    }
                    SessionOverflowMenu(
                        active = state.header.active,
                        // Web terminalSupport gating: entry needs an active
                        // session AND a host that reports the capability.
                        onOpenTerminal = if (state.header.active && state.header.terminalSupported) onOpenTerminal else null,
                        // Web canViewAgentTerminal gating for the overflow toggle
                        // (the PTY panel's own entry point).
                        onToggleAgentTerminal = if (
                            agentTerminal != null && state.header.active && state.header.agentPty
                        ) {
                            { agentTerminalVisible = !agentTerminalVisible }
                        } else {
                            null
                        },
                        onOpenOutline = { outlineSheetOpen = true },
                        onRename = { renameDialogOpen = true },
                        onExport = if (sessionExport != null) {
                            { exportDialogOpen = true }
                        } else {
                            null
                        },
                        onReopen = viewModel::reopenSession,
                        reopenDisabledReason = reopenDisabledReason,
                        reopenHint = reopenHint,
                        onDelete = { deleteDialogOpen = true },
                    )
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
        bottomBar = {
            app.hapi.companion.ui.theme.ReadingColumn {
                // Edge-to-edge (enforced by targetSdk 35+): the bar owns its own
                // system insets — nav-bar padding when the keyboard is closed,
                // IME padding when open (inset consumption prevents doubling).
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .navigationBarsPadding()
                        .imePadding(),
                ) {
                    if (!state.header.active && !state.isInitialLoading && !state.loadFailed) {
                        // Mutually exclusive: the send-failure card replaces the
                        // plain inactive bar (both offer Reopen — never both).
                        // The card path is gated in the ViewModel
                        // (resumeAndRetry refuses a blocked resume), so only
                        // the bar needs the cursor-gate presentation.
                        if (reopenCard.visible) {
                            SendFailureReopenCard(card = reopenCard, onReopen = viewModel::reopenSession)
                        } else {
                            InactiveSessionBar(
                                canResume = state.inactiveCanResume,
                                reopenDisabledReason = reopenDisabledReason,
                                onReopen = viewModel::reopenSession,
                            )
                        }
                    }
                    QueuedMessagesBar(
                        rows = queuedRows,
                        onSteer = viewModel::steerQueuedMessage,
                        onRetry = viewModel::retryIndeterminateMessage,
                        onEdit = viewModel::editQueuedMessage,
                        onCancel = viewModel::cancelQueuedMessage,
                    )
                    // Context-remaining readout; rides the same strip as the
                    // mode chip and hides until the thread reports usage.
                    ContextUsageChip(indicator = state.contextUsage)
                    // Web StatusBar parity: the current permission mode rides
                    // directly above the composer; tapping opens the config
                    // sheet that hosts the switcher (the web span itself is
                    // not clickable).
                    PermissionModeChip(
                        config = configState,
                        onClick = { configSheetOpen = true },
                    )
                    ChatComposer(
                        state = composerState,
                        onTextChange = viewModel::setComposerText,
                        onSend = { viewModel.sendMessage() },
                        onSendSteer = { viewModel.sendMessage(steer = true) },
                        onAbort = viewModel::abortSession,
                        attachments = attachmentItems,
                        onAddAttachment = { attachmentSheetOpen = true },
                        onAttachmentRetry = viewModel.attachments::retry,
                        onAttachmentRemove = viewModel.attachments::remove,
                        onAttachmentMove = viewModel.attachments::move,
                        onPasteFromClipboard = pasteFromClipboard,
                        slashSuggestions = slashSuggestions,
                        onSlashCommandSelected = viewModel::selectSlashCommand,
                        skillSuggestions = skillSuggestions,
                        onSkillSelected = viewModel::selectSkill,
                        mentionSuggestions = mentionSuggestions,
                        onMentionSelected = viewModel::selectMentionSuggestion,
                        pendingSchedule = pendingSchedule,
                        onScheduleSelected = viewModel::setPendingSchedule,
                        onClearSchedule = { viewModel.setPendingSchedule(null) },
                        dictation = if (dictationAvailable) dictationState else null,
                        onDictationToggle = onDictationToggle,
                        onDictationCancel = { dictation?.cancel() },
                        onOpenFiles = onOpenFiles,
                        onOpenScratchlist = if (viewModel.scratchlistEnabled) onOpenScratchlist else null,
                        onParkDraft = if (
                            parkDraftEligible(viewModel.scratchlistEnabled, composerState.text)
                        ) {
                            viewModel::parkComposerDraft
                        } else {
                            null
                        },
                        scratchlistCount = scratchlistCount,
                        onToggleScratchlist = if (viewModel.scratchlistEnabled) {
                            { viewModel.setScratchlistMode(!composerState.routesToScratchlist) }
                        } else {
                            null
                        },
                    )
                }
            }
        },
    ) { padding ->
        CompositionLocalProvider(
            LocalMarkdownRenderCache provides viewModel.markdownCache,
            LocalChatMedia provides media,
            LocalMarkdownLinkHandler provides rememberChatLinkHandler(onOpenFile = onOpenFile, onOpenSession = onOpenSession),
            LocalChatInteractions provides interactions,
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
            ) {
                // Web mounts the banner between header and thread
                // (`SessionChat.tsx`) — metadata-driven via SSE, visible even
                // while the transcript is still loading (#873).
                cursorMigrationBanner?.let { CursorMigrationBanner(state = it) }
                // Collapsed-by-default live summary; null when the session has
                // no goal, todos, subagents or background terminals.
                state.sessionStatus?.let { status ->
                    SessionStatusPanel(status = status)
                }
                // Roster of the session's subagent team; null while the
                // session carries no team state.
                state.teamRoster?.let { roster ->
                    TeamRosterPanel(roster = roster)
                }
                Box(modifier = Modifier.weight(1f)) {
                    when {
                        state.isInitialLoading -> InitialLoading()
                        state.loadFailed -> LoadFailed(onRetry = viewModel::retry)
                        // Web parity: the visible agent terminal REPLACES the
                        // transcript (web hides the thread with display:none);
                        // the composer below stays for chat.
                        agentTerminalVisible && agentTerminal != null -> AgentTerminalPanel(
                            viewModel = agentTerminal,
                            onHide = { agentTerminalVisible = false },
                            modifier = Modifier.fillMaxSize(),
                        )
                        state.blocks.isEmpty() && !state.hasMore -> EmptyChat()
                        else -> ChatTranscript(
                            state = state, paging = historyPaging, jumpToken = jumpToken,
                            jumpingLatest = jumpingLatest,
                            onViewport = viewModel::readingViewportChanged,
                            onLayout = viewModel::historyLaidOut,
                            onRetryHistory = viewModel::loadOlder,
                            onJumpToLatest = viewModel::jumpToLatest,
                            listState = transcriptList, readingState = readingState,
                            messageAggregates = state.messageAggregates,
                            onShowMessageInfo = { messageInfoBlock = it },
                            onShareTurn = { shareTurnBlock = it },
                        )
                    }
                    if (!state.loadFailed) state.warning?.let { warning ->
                        Box(Modifier.align(Alignment.TopCenter).padding(8.dp)) {
                            DegradedBanner(warning, viewModel::retry)
                        }
                    }
                }
            }
        }
    }

    if (attachmentSheetOpen) {
        AttachmentPickerSheet(
            onDismiss = { attachmentSheetOpen = false },
            onPickPhotos = {
                photoPickerLauncher.launch(
                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo),
                )
            },
            onTakePhoto = onTakePhoto,
            onPickFiles = { documentPickerLauncher.launch(arrayOf("*/*")) },
            clipboardLabel = clipboardPick?.first,
            onPasteFromClipboard = { clipboardPick?.second?.let(::ingestUris) },
        )
    }
    if (configSheetOpen) {
        SessionConfigSheet(
            config = configState,
            onDismiss = { configSheetOpen = false },
            onSetPermissionMode = viewModel::setPermissionMode,
            onSetModel = viewModel::setModel,
            onSetEffort = viewModel::setEffort,
            onLoadModelOptions = viewModel::loadModelOptions,
            onSetServiceTier = viewModel::setServiceTier,
        )
    }
    if (outlineSheetOpen) {
        OutlinePanel(
            items = state.conversationOutline,
            hasMore = state.hasMore,
            loadingMore = state.isLoadingOlder || state.isSyncingTail,
            onLoadMore = viewModel::loadOlder,
            onSelect = onOutlineSelect,
            onDismiss = { outlineSheetOpen = false },
        )
    }
    if (renameDialogOpen) {
        RenameSessionDialog(
            initialName = state.header.name ?: state.header.title,
            onConfirm = { name ->
                renameDialogOpen = false
                viewModel.renameSession(name)
            },
            onDismiss = { renameDialogOpen = false },
        )
    }
    if (deleteDialogOpen) {
        DeleteSessionDialog(
            sessionTitle = state.header.title,
            // Web SessionHeader: entries present ⇒ "This will also delete N
            // scratchlist entries." appended to the base description.
            scratchlistCount = scratchlistCount,
            onConfirm = {
                deleteDialogOpen = false
                viewModel.deleteSession()
            },
            onDismiss = { deleteDialogOpen = false },
        )
    }
    if (exportDialogOpen && sessionExport != null) {
        SessionExportDialog(
            sessionId = viewModel.sessionId,
            support = sessionExport,
            onDismiss = { exportDialogOpen = false },
            onSaved = { filename ->
                scope.launch {
                    snackbarHostState.showSnackbar(
                        context.getString(R.string.session_export_saved, filename),
                    )
                }
            },
        )
    }
    val conversationHistory by viewModel.conversationHistory.collectAsState()
    conversationHistory.dialog?.let { action ->
        HistoryActionConfirmDialog(
            action = action,
            pending = conversationHistory.opPending,
            onConfirm = viewModel::confirmHistoryAction,
            onDismiss = viewModel::dismissHistoryDialog,
        )
    }
    if (conversationHistory.rewindFallbackLocalId != null) {
        RewindFallbackDialog(
            pending = conversationHistory.opPending,
            onConfirm = viewModel::confirmRewindFallback,
            onDismiss = viewModel::dismissRewindFallback,
        )
    }
    messageInfoBlock?.let { infoBlock ->
        val labels = remember(infoBlock, state.messageAggregates) {
            messageMetadataForBlock(infoBlock, state.messageAggregates)
                ?.let(::buildMessageMetadataLabels)
                .orEmpty()
        }
        if (labels.isNotEmpty()) {
            MessageMetadataDialog(
                labels = labels,
                onDismiss = { messageInfoBlock = null },
            )
        }
    }
    shareTurnBlock?.let { shareBlock ->
        ShareTurnDialog(
            target = shareBlock,
            blocks = state.blocks,
            info = state.shareTurnInfo,
            onDismiss = { shareTurnBlock = null },
        )
    }
}

/**
 * Top-bar ⋮ menu — session-scoped actions only: terminal entries (interactive
 * terminal / agent PTY toggle) when the session supports them, Rename always,
 * Reopen only for inactive sessions, Delete last. The navigation/quick actions
 * (Files / Scratchlist / Park) live in the composer action row now, one
 * thumb-reach closer to the draft they act on.
 */
@Composable
private fun SessionOverflowMenu(
    active: Boolean,
    onRename: () -> Unit,
    onReopen: () -> Unit,
    onDelete: () -> Unit,
    /** null ⇒ hidden (no export support / tests). */
    onExport: (() -> Unit)? = null,
    /** Cursor reopen gate reason (missing/checking) — disables the item. */
    reopenDisabledReason: String? = null,
    /** Cursor probe-unverified hint — item stays enabled with a caveat. */
    reopenHint: String? = null,
    /** null ⇒ terminal row hidden (inactive/unsupported session / tests). */
    onOpenTerminal: (() -> Unit)? = null,
    /** null ⇒ agent-terminal toggle row hidden (non-PTY/inactive session / tests). */
    onToggleAgentTerminal: (() -> Unit)? = null,
    /** null ⇒ outline row hidden (tests / previews). */
    onOpenOutline: (() -> Unit)? = null,
) {
    var open by remember { mutableStateOf(false) }
    IconButton(onClick = { open = true }) {
        Icon(Icons.Filled.MoreVert, contentDescription = stringResource(R.string.chat_session_actions))
    }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
        if (onOpenTerminal != null) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.chat_open_terminal)) },
                onClick = {
                    open = false
                    onOpenTerminal()
                },
            )
        }
        if (onToggleAgentTerminal != null) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.agent_terminal_menu)) },
                onClick = {
                    open = false
                    onToggleAgentTerminal()
                },
            )
        }
        if (onOpenOutline != null) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.outline_open)) },
                onClick = {
                    open = false
                    onOpenOutline()
                },
            )
        }
        HorizontalDivider()
        DropdownMenuItem(
            text = { Text(stringResource(R.string.sessions_action_rename)) },
            onClick = {
                open = false
                onRename()
            },
        )
        if (onExport != null) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.sessions_action_export)) },
                onClick = {
                    open = false
                    onExport()
                },
            )
        }
        if (!active) {
            DropdownMenuItem(
                text = {
                    Column {
                        Text(stringResource(R.string.sessions_action_reopen))
                        (reopenDisabledReason ?: reopenHint)?.let { hint ->
                            Text(
                                text = hint,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                },
                enabled = reopenDisabledReason == null,
                onClick = {
                    open = false
                    onReopen()
                },
            )
        }
        DropdownMenuItem(
            text = { Text(stringResource(R.string.sessions_action_delete), color = MaterialTheme.colorScheme.error) },
            onClick = {
                open = false
                onDelete()
            },
        )
    }
}

/**
 * Inactive-session affordance above the composer: sending auto-resumes
 * (B-M3ab), Reopen is the explicit restart without a message. The web swaps
 * the bar copy on `!inactiveCanResume` (cannotResume) and keeps the reopen
 * row disabled while the Cursor gate is checking; the same two inputs drive
 * this bar (#1084).
 */
@Composable
private fun InactiveSessionBar(
    canResume: Boolean,
    onReopen: () -> Unit,
    reopenDisabledReason: String? = null,
) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = when {
                    !canResume -> stringResource(R.string.chat_inactive_cannot_resume)
                    reopenDisabledReason != null -> reopenDisabledReason
                    else -> stringResource(R.string.chat_inactive_bar)
                },
                style = MaterialTheme.typography.labelMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 16.dp, top = 4.dp, bottom = 4.dp),
            )
            if (canResume) {
                TextButton(enabled = reopenDisabledReason == null, onClick = onReopen) {
                    Text(stringResource(R.string.sessions_action_reopen))
                }
            }
        }
    }
}

/**
 * Send-failure error card (slice 6d): a send failed because the session was
 * inactive and the auto-resume failed — error-styled like the web's inline
 * `chat.sendError.sessionInactive` card, offering Reopen (disabled + spinner
 * while a reopen is in flight). Replaces [InactiveSessionBar] while visible.
 */
@Composable
private fun SendFailureReopenCard(card: SendFailureReopenCard, onReopen: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = stringResource(R.string.chat_send_error_session_inactive),
                style = MaterialTheme.typography.labelMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 16.dp, top = 6.dp, bottom = 6.dp),
            )
            TextButton(onClick = onReopen, enabled = !card.reopenPending) {
                if (card.reopenPending) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        strokeWidth = 2.dp,
                    )
                    Spacer(modifier = Modifier.size(8.dp))
                }
                Text(stringResource(R.string.sessions_action_reopen))
            }
        }
    }
}

@Composable
private fun ChatTitle(header: ChatHeaderUi, reconnecting: Boolean, retry: () -> Unit) {
    Column(Modifier.heightIn(min = 48.dp).then(if (reconnecting) Modifier.clickable(onClick = retry) else Modifier),
        verticalArrangement = Arrangement.Center) {
        Text(header.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        // Always reserve the subtitle slot; reconnect phases never resize the transcript.
        Text(
            if (reconnecting) stringResource(R.string.chat_reconnecting_retry) else header.subtitle.orEmpty(),
            style = app.hapi.companion.ui.theme.HapiTypography.caption,
            color = if (reconnecting) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun DegradedBanner(warning: String, onRetry: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = warning,
                style = MaterialTheme.typography.labelMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 16.dp, top = 6.dp, bottom = 6.dp),
            )
            TextButton(onClick = onRetry) { Text(stringResource(R.string.chat_retry)) }
        }
    }
}

// ----------------------------------------------------------------- states --

@Composable
private fun InitialLoading() {
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator()
        Spacer(modifier = Modifier.size(12.dp))
        Text(
            text = stringResource(R.string.chat_loading_messages),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun LoadFailed(onRetry: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(text = stringResource(R.string.chat_load_failed_title), style = MaterialTheme.typography.titleMedium)
        Spacer(modifier = Modifier.size(8.dp))
        Text(
            text = stringResource(R.string.chat_load_failed_hint),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(modifier = Modifier.size(12.dp))
        TextButton(onClick = onRetry) { Text(stringResource(R.string.chat_retry)) }
    }
}

@Composable
private fun EmptyChat() {
    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(text = stringResource(R.string.chat_empty_title), style = MaterialTheme.typography.titleMedium)
        Spacer(modifier = Modifier.size(8.dp))
        Text(
            text = stringResource(R.string.chat_empty_hint),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// ------------------------------------------------------------- notices --

/**
 * Localize a [ChatNotice] (B-M5a). Server/exception detail text, when
 * present, is shown verbatim — matching the pre-i18n `message ?: fallback`
 * behavior — so hub-side wording is never mistranslated.
 */
internal fun chatNoticeText(context: Context, notice: ChatNotice): String = when (notice) {
    ChatNotice.DraftParked -> context.getString(R.string.chat_notice_draft_parked)
    ChatNotice.ScratchlistFull -> context.getString(R.string.chat_notice_scratchlist_full)
    ChatNotice.ScratchlistParkFailed -> context.getString(R.string.chat_notice_park_failed)
    ChatNotice.ScratchlistPromoteStagingFailed ->
        context.getString(R.string.chat_notice_scratchlist_stage_failed)
    ChatNotice.ScratchlistRehydratePartial ->
        context.getString(R.string.chat_notice_scratchlist_rehydrate_failed)
    ChatNotice.AttachmentsUploading -> context.getString(R.string.chat_notice_attachments_uploading)
    ChatNotice.ResumeFailed -> context.getString(R.string.chat_notice_resume_failed)
    ChatNotice.QueuedEditKeptDraft -> context.getString(R.string.chat_notice_edit_kept_draft)
    ChatNotice.QueuedAlreadyDelivered -> context.getString(R.string.chat_notice_already_delivered)
    ChatNotice.PermissionAlreadyHandled -> context.getString(R.string.chat_notice_request_already_handled)
    ChatNotice.DeleteConflictActive -> context.getString(R.string.sessions_error_delete_active)
    is ChatNotice.AbortFailed -> notice.detail ?: context.getString(R.string.chat_notice_abort_failed)
    is ChatNotice.RenameFailed -> notice.detail ?: context.getString(R.string.chat_notice_rename_failed)
    is ChatNotice.DeleteFailed -> notice.detail ?: context.getString(R.string.chat_notice_delete_failed)
    is ChatNotice.ReopenFailed -> notice.detail ?: context.getString(R.string.sessions_reopen_failed_fallback)
    is ChatNotice.CancelQueuedFailed -> notice.detail ?: context.getString(R.string.chat_notice_cancel_failed)
    is ChatNotice.SteerFailed -> notice.detail ?: context.getString(R.string.chat_notice_steer_failed)
    is ChatNotice.PermissionRequestFailed -> notice.detail ?: context.getString(R.string.chat_notice_request_failed)
    is ChatNotice.ModelsLoadFailed -> notice.detail ?: context.getString(R.string.chat_notice_models_failed)
    is ChatNotice.ConfigUpdateFailed -> notice.detail ?: context.getString(R.string.chat_notice_config_failed)
    is ChatNotice.ForkFailed -> notice.detail ?: context.getString(R.string.chat_notice_fork_failed)
    is ChatNotice.RewindFailed -> notice.detail ?: context.getString(R.string.chat_notice_rewind_failed)
    ChatNotice.RewindDiverged -> context.getString(R.string.chat_notice_rewind_diverged)
}
