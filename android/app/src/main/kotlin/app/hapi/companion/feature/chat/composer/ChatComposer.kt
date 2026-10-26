package app.hapi.companion.feature.chat.composer

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.chat.ComposerUiState
import app.hapi.companion.feature.chat.attachments.ComposerAttachmentStatus
import app.hapi.companion.feature.chat.attachments.ComposerAttachmentUi
import app.hapi.companion.feature.chat.attachments.rememberChipThumbnail
import app.hapi.companion.ui.components.ArrowUpGlyph
import app.hapi.companion.ui.components.FolderGlyph
import app.hapi.companion.ui.components.MicGlyph
import app.hapi.companion.ui.components.PlusGlyph
import app.hapi.companion.ui.components.StopGlyph
import app.hapi.companion.ui.components.ScheduleGlyph
import app.hapi.companion.ui.components.HapiImageGlyph
import app.hapi.companion.ui.components.HapiInboxGlyph
import app.hapi.companion.ui.components.HapiNoteGlyph
import app.hapi.companion.ui.components.HapiPaperclipGlyph
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.wire.SkillSummary
import app.hapi.protocol.wire.SlashCommand
import kotlinx.coroutines.delay

/**
 * The chat input card (B-M3a, extended in B-M3ce/B-M3f/B-M16b): attachments and the
 * multiline text field grow above a fixed bottom action row. The trailing
 * primary action is stateful: Stop while a turn runs with an empty draft,
 * otherwise Send (long-press offers "Send & steer" during a turn). The card
 * also hosts dictation, attachment and schedule-send controls, while slash /
 * mention suggestions stay outside so the popup cannot be clipped by the
 * rounded surface.
 *
 * The leading side of the action row carries the quick navigations (Files /
 * Scratchlist / Park): web's narrow viewport folds its model/effort value
 * buttons into the settings gear so only those three stay directly reachable
 * (ComposerButtons.tsx `effectiveLayout`), and Android is permanently
 * narrow — so the same set belongs in the row while model/mode/effort live
 * behind the top-bar gear.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ChatComposer(
    state: ComposerUiState,
    onTextChange: (String) -> Unit,
    onSend: () -> Unit,
    onSendSteer: () -> Unit,
    onAbort: () -> Unit,
    modifier: Modifier = Modifier,
    attachments: List<ComposerAttachmentUi> = emptyList(),
    onAddAttachment: (() -> Unit)? = null,
    onAttachmentRetry: (String) -> Unit = {},
    onAttachmentRemove: (String) -> Unit = {},
    /** Drag-to-reorder (web `SortableComposerAttachments`): from → to index. */
    onAttachmentMove: (Int, Int) -> Unit = { _, _ -> },
    /** null ⇒ no clipboard paste interception (previews); true ⇒ chips added. */
    onPasteFromClipboard: (() -> Boolean)? = null,
    slashSuggestions: List<SlashCommand> = emptyList(),
    onSlashCommandSelected: (SlashCommand) -> Unit = {},
    /** `$` skills menu (web `getSkillSuggestions`); empty hides it. */
    skillSuggestions: List<SkillSummary> = emptyList(),
    onSkillSelected: (SkillSummary) -> Unit = {},
    /** `@word` mention rows (B-M16a); rendered when the slash dropdown is empty. */
    mentionSuggestions: List<MentionSuggestion> = emptyList(),
    onMentionSelected: (MentionSuggestion) -> Unit = {},
    /**
     * Pending scheduled-send pick (B-M16b); non-null turns the clock button
     * accent-filled, disables the attach button (web `hasSchedule`) and makes
     * the next Send resolve `scheduledAt` at the send instant.
     */
    pendingSchedule: PendingSchedule? = null,
    onScheduleSelected: (PendingSchedule) -> Unit = {},
    onClearSchedule: () -> Unit = {},
    /** null ⇒ dictation unavailable (no controller wired) — mic button hidden. */
    dictation: DictationState? = null,
    onDictationToggle: () -> Unit = {},
    onDictationCancel: () -> Unit = {},
    /** null ⇒ Files quick action hidden (tests / previews). */
    onOpenFiles: (() -> Unit)? = null,
    /** null ⇒ Scratchlist quick action hidden (feature off / tests). */
    onOpenScratchlist: (() -> Unit)? = null,
    /** null ⇒ Park quick action hidden (scratchlist off or empty draft). */
    onParkDraft: (() -> Unit)? = null,
    /** Scratchlist entry count for the mode-toggle badge; 0 hides it. */
    scratchlistCount: Int = 0,
    /** null ⇒ the scratchlist mode toggle is hidden (no store wired). */
    onToggleScratchlist: (() -> Unit)? = null,
) {
    val focusRequester = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    // Do not replay an old focus intent when returning from an inspector.
    var handledFocusRequest by remember { mutableLongStateOf(state.focusRequest) }
    // Schedule panel toggle (B-M16b); opens fresh in the Relative tab each
    // time because the picker composes only while open (web remounts too).
    var schedulePickerOpen by remember { mutableStateOf(false) }
    val hasSchedule = pendingSchedule != null
    LaunchedEffect(state.focusRequest) {
        if (state.focusRequest != handledFocusRequest) {
            handledFocusRequest = state.focusRequest
            focusRequester.requestFocus()
            keyboard?.show()
        }
    }
    Surface(color = MaterialTheme.colorScheme.surface, modifier = modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(vertical = 8.dp)) {
            // One trigger at a time: the text cannot start with both `/` and `$`.
            if (slashSuggestions.isNotEmpty()) {
                SlashCommandDropdown(
                    suggestions = slashSuggestions,
                    onSelect = onSlashCommandSelected,
                    modifier = Modifier.padding(bottom = 6.dp),
                )
            } else if (skillSuggestions.isNotEmpty()) {
                SkillSuggestionDropdown(
                    suggestions = skillSuggestions,
                    onSelect = onSkillSelected,
                    modifier = Modifier.padding(bottom = 6.dp),
                )
            } else if (mentionSuggestions.isNotEmpty()) {
                MentionDropdown(
                    suggestions = mentionSuggestions,
                    onSelect = onMentionSelected,
                    modifier = Modifier.padding(bottom = 6.dp),
                )
            }
            if (schedulePickerOpen) {
                ScheduleTimePicker(
                    pendingSchedule = pendingSchedule,
                    onSchedule = {
                        schedulePickerOpen = false
                        onScheduleSelected(it)
                    },
                    modifier = Modifier.padding(bottom = 6.dp),
                )
            }
            // Scratchlist mode banner (web drawer header twin): while Send
            // parks instead of delivering, an amber hint rides above the card.
            if (state.routesToScratchlist) {
                ScratchlistModeHint(modifier = Modifier.padding(bottom = 6.dp))
            }
            Surface(
                color = MaterialTheme.colorScheme.surfaceContainerLow,
                shape = RoundedCornerShape(20.dp),
                tonalElevation = 1.dp,
                shadowElevation = 2.dp,
                border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outlineVariant),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column {
                    if (attachments.isNotEmpty()) {
                        // Long-press-drag reorders chips live (web twin:
                        // SortableComposerAttachments.tsx). pointerInput sits
                        // AFTER padding in the chain so pointer positions share
                        // the content-origin coordinate space with
                        // visibleItemsInfo offsets; keyed on Unit + updated
                        // callbacks so upload-status list churn never cancels
                        // a drag mid-gesture.
                        val listState = rememberLazyListState()
                        var draggingId by remember { mutableStateOf<String?>(null) }
                        val currentOnMove by rememberUpdatedState(onAttachmentMove)
                        val haptics = LocalHapticFeedback.current

                        fun itemUnder(x: Float) =
                            listState.layoutInfo.visibleItemsInfo.firstOrNull {
                                x >= it.offset && x < it.offset + it.size
                            }

                        LazyRow(
                            state = listState,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 2.dp)
                                .pointerInput(Unit) {
                                    detectDragGesturesAfterLongPress(
                                        onDragStart = { offset ->
                                            val picked = itemUnder(offset.x)?.key as? String
                                            if (picked != null) {
                                                draggingId = picked
                                                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                            }
                                        },
                                        onDrag = { change, _ ->
                                            change.consume()
                                            val active = draggingId
                                                ?: return@detectDragGesturesAfterLongPress
                                            val activeItem = listState.layoutInfo.visibleItemsInfo
                                                .firstOrNull { it.key == active }
                                                ?: return@detectDragGesturesAfterLongPress
                                            val target = itemUnder(change.position.x)
                                                ?: return@detectDragGesturesAfterLongPress
                                            // Swap on crossing; keyed items keep
                                            // identity across swaps (no animateItem).
                                            if (target.index != activeItem.index) {
                                                currentOnMove(activeItem.index, target.index)
                                            }
                                        },
                                        onDragEnd = { draggingId = null },
                                        onDragCancel = { draggingId = null },
                                    )
                                },
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            items(attachments, key = { it.id }) { attachment ->
                                ComposerAttachmentChip(
                                    attachment = attachment,
                                    dragging = attachment.id == draggingId,
                                    onRetry = { onAttachmentRetry(attachment.id) },
                                    onRemove = { onAttachmentRemove(attachment.id) },
                                )
                            }
                        }
                    }
                    val recording = dictation as? DictationState.Recording
                    if (recording != null) {
                        RecordingChip(
                            startedAtMs = recording.startedAtMs,
                            onCancel = onDictationCancel,
                            modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 2.dp),
                        )
                    }
                    BasicTextField(
                        value = state.text,
                        onValueChange = onTextChange,
                        textStyle = app.hapi.companion.ui.theme.HapiTypography.body.copy(
                            color = MaterialTheme.colorScheme.onSurface,
                        ),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                        maxLines = 6,
                        modifier = Modifier
                            .focusRequester(focusRequester)
                            .testTag("chat-composer-input")
                            // Hardware-keyboard paste-to-attach (web
                            // handlePaste): consume Ctrl/Cmd+V only when the
                            // clipboard carried attachable files, otherwise
                            // return false so the default text paste runs.
                            .onPreviewKeyEvent { event ->
                                val paste = onPasteFromClipboard
                                    ?: return@onPreviewKeyEvent false
                                // Stack-only paste-to-attach path: while a
                                // schedule is pending the attach controls are
                                // mutually exclusive ("+" disables), so let the
                                // paste fall through to plain text instead.
                                if (hasSchedule) {
                                    return@onPreviewKeyEvent false
                                }
                                if (event.type != KeyEventType.KeyDown) {
                                    return@onPreviewKeyEvent false
                                }
                                val isPasteKey =
                                    (event.isCtrlPressed || event.isMetaPressed) && event.key == Key.V
                                if (isPasteKey) paste() else false
                            }
                            .fillMaxWidth()
                            .padding(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 4.dp),
                        decorationBox = { inner ->
                            Box {
                                if (state.text.isEmpty()) {
                                    Text(
                                        text = stringResource(R.string.chat_composer_placeholder),
                                        style = MaterialTheme.typography.bodyLarge,
                                        color = MaterialTheme.hapi.hint,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                inner()
                            }
                        },
                    )
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            // 48 dp touch slot with a centered 38 dp circle:
                            // 7 + 5 = the shared 12 dp visual inset.
                            .padding(start = 7.dp, end = 7.dp, bottom = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (onAddAttachment != null) {
                            ComposerActionButton(
                                contentDescription = stringResource(R.string.chat_composer_add_attachment),
                                onClick = onAddAttachment,
                                // web: attachments and a schedule are mutually
                                // exclusive (`disabled={controlsDisabled || hasSchedule}`).
                                enabled = !hasSchedule,
                            ) {
                                Icon(PlusGlyph, contentDescription = null, modifier = Modifier.size(20.dp))
                            }
                        }
                        if (onOpenFiles != null) {
                            ComposerActionButton(
                                contentDescription = stringResource(R.string.chat_open_files),
                                onClick = onOpenFiles,
                            ) {
                                Icon(FolderGlyph, contentDescription = null, modifier = Modifier.size(19.dp))
                            }
                        }
                        if (onOpenScratchlist != null) {
                            ComposerActionButton(
                                contentDescription = stringResource(R.string.chat_open_scratchlist),
                                onClick = onOpenScratchlist,
                            ) {
                                Icon(HapiNoteGlyph, contentDescription = null, modifier = Modifier.size(19.dp))
                            }
                        }
                        if (onParkDraft != null) {
                            ComposerActionButton(
                                contentDescription = stringResource(R.string.chat_park_draft),
                                onClick = onParkDraft,
                            ) {
                                Icon(HapiInboxGlyph, contentDescription = null, modifier = Modifier.size(19.dp))
                            }
                        if (onToggleScratchlist != null) {
                            ScratchlistToggleButton(
                                active = state.routesToScratchlist,
                                count = scratchlistCount,
                                onToggle = onToggleScratchlist,
                            )
                        }
                        Spacer(modifier = Modifier.weight(1f))
                        // Clock toggle (B-M16b, web ComposerButtons schedule
                        // slot): with a pending pick the tap clears it; else it
                        // toggles the picker. Disabled while sending or with
                        // attachments on the tray (web `controlsDisabled ||
                        // hasAttachments`); accent-filled while pending.
                        ComposerActionButton(
                            contentDescription = stringResource(R.string.chat_schedule_send),
                            onClick = {
                                if (hasSchedule) {
                                    schedulePickerOpen = false
                                    onClearSchedule()
                                } else {
                                    schedulePickerOpen = !schedulePickerOpen
                                }
                            },
                            enabled = !state.isSending && attachments.isEmpty(),
                            color = if (hasSchedule) {
                                MaterialTheme.colorScheme.primary
                            } else {
                                MaterialTheme.colorScheme.surfaceContainerHigh
                            },
                            contentColor = if (hasSchedule) {
                                MaterialTheme.colorScheme.onPrimary
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            },
                        ) {
                            Icon(ScheduleGlyph, contentDescription = null, modifier = Modifier.size(19.dp))
                        }
                        if (dictation != null) {
                            MicButton(state = dictation, onToggle = onDictationToggle)
                        }
                        PrimaryActionButton(
                            state = state,
                            attachments = attachments,
                            onSend = onSend,
                            onSendSteer = onSendSteer,
                            onAbort = onAbort,
                        )
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------- attachments --

/**
 * One tray chip: 36 dp thumb (image preview / MIME glyph, spinner while
 * uploading), filename + status line, ✕ to remove. A failed chip tints error
 * and taps to retry. [dragging] lifts + dims the chip under a reorder drag
 * (web dims the dragged chip, SortableComposerAttachments.tsx).
 */
@Composable
private fun ComposerAttachmentChip(
    attachment: ComposerAttachmentUi,
    dragging: Boolean = false,
    onRetry: () -> Unit,
    onRemove: () -> Unit,
) {
    val failed = attachment.status == ComposerAttachmentStatus.Failed
    Surface(
        color = if (failed) {
            MaterialTheme.colorScheme.errorContainer
        } else {
            MaterialTheme.colorScheme.surfaceContainerHigh
        },
        contentColor = if (failed) {
            MaterialTheme.colorScheme.onErrorContainer
        } else {
            MaterialTheme.colorScheme.onSurface
        },
        shape = RoundedCornerShape(10.dp),
        shadowElevation = if (dragging) 6.dp else 0.dp,
        onClick = { if (failed) onRetry() },
        enabled = failed,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .graphicsLayer { alpha = if (dragging) 0.65f else 1f }
                .padding(start = 6.dp, top = 6.dp, bottom = 6.dp),
        ) {
            ChipThumb(attachment)
            Column(modifier = Modifier.padding(start = 8.dp).widthIn(max = 132.dp)) {
                Text(
                    text = attachment.filename,
                    style = MaterialTheme.typography.labelMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = when (attachment.status) {
                        ComposerAttachmentStatus.Uploading -> stringResource(R.string.chat_attachment_uploading)
                        ComposerAttachmentStatus.Failed -> stringResource(R.string.chat_attachment_failed_retry)
                        ComposerAttachmentStatus.Ready -> formatChipSize(attachment.sizeBytes)
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.hapi.hint,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Icon(
                imageVector = Icons.Default.Close,
                contentDescription = null,
                tint = MaterialTheme.hapi.hint,
                modifier = Modifier
                    .clip(CircleShape)
                    .clickable(onClick = onRemove)
                    .padding(horizontal = 10.dp, vertical = 8.dp)
                    .size(14.dp),
            )
        }
    }
}

@Composable
private fun ChipThumb(attachment: ComposerAttachmentUi) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(36.dp)
            .clip(RoundedCornerShape(8.dp)),
    ) {
        val thumbnail = rememberChipThumbnail(attachment.previewBytes)
        if (thumbnail != null) {
            Image(
                bitmap = thumbnail,
                contentDescription = attachment.filename,
                contentScale = ContentScale.Crop,
                modifier = Modifier
                    .size(36.dp)
                    .graphicsLayer {
                        alpha = if (attachment.status == ComposerAttachmentStatus.Uploading) 0.4f else 1f
                    },
            )
        } else {
            Surface(color = MaterialTheme.colorScheme.surfaceContainerHighest, modifier = Modifier.size(36.dp)) {}
            Icon(
                imageVector = if (attachment.mimeType.startsWith("image/")) HapiImageGlyph else HapiPaperclipGlyph,
                contentDescription = null,
                tint = MaterialTheme.hapi.hint,
                modifier = Modifier.size(16.dp),
            )
        }
        if (attachment.status == ComposerAttachmentStatus.Uploading) {
            CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
        }
    }
}

/** `12.3 MB` / `456 KB` / `789 B` chip size label. */
internal fun formatChipSize(bytes: Long): String = when {
    bytes >= 1024 * 1024 -> "%.1f MB".format(bytes / (1024.0 * 1024.0))
    bytes >= 1024 -> "%.0f KB".format(bytes / 1024.0)
    else -> "$bytes B"
}

/**
 * Park affordance gate (the web overflow item's own condition): the quick
 * action renders only when the scratchlist feature is on and the composer
 * actually holds a non-blank draft to park.
 */
internal fun parkDraftEligible(scratchlistEnabled: Boolean, draftText: String): Boolean =
    scratchlistEnabled && draftText.isNotBlank()

/** Shared 48 dp touch target with a centered 38 dp visual circle. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ComposerActionButton(
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    onLongClick: (() -> Unit)? = null,
    color: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.surfaceContainerHigh,
    contentColor: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.onSurfaceVariant,
    enabled: Boolean = true,
    content: @Composable () -> Unit,
) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .size(48.dp)
            .clip(CircleShape)
            .combinedClickable(
                enabled = enabled,
                onClick = onClick,
                onLongClick = onLongClick,
            )
            .semantics(mergeDescendants = true) {
                this.contentDescription = contentDescription
                role = Role.Button
                if (!enabled) disabled()
            },
    ) {
        Surface(
            color = color,
            contentColor = contentColor,
            shape = CircleShape,
            modifier = Modifier.size(38.dp),
        ) {
            Box(contentAlignment = Alignment.Center) { content() }
        }
    }
}

// ------------------------------------------------------- scratchlist mode --

/** Web `amber-500` — the scratchlist-mode accent (send, toggle, banner). */
private val ScratchlistAmber = androidx.compose.ui.graphics.Color(0xFFF59E0B)

/**
 * Sticky-note toggle for scratchlist composer mode (web note-icon toggle):
 * amber while active, with the entry-count badge (99+ cap, web parity).
 */
@Composable
private fun ScratchlistToggleButton(
    active: Boolean,
    count: Int,
    onToggle: () -> Unit,
) {
    Box {
        ComposerActionButton(
            contentDescription = stringResource(R.string.chat_composer_scratchlist_toggle),
            onClick = onToggle,
            color = if (active) ScratchlistAmber else MaterialTheme.colorScheme.surfaceContainerHigh,
            contentColor = if (active) androidx.compose.ui.graphics.Color.White
            else MaterialTheme.colorScheme.onSurfaceVariant,
        ) {
            Icon(HapiNoteGlyph, contentDescription = null, modifier = Modifier.size(19.dp))
        }
        if (count > 0) {
            Surface(
                color = if (active) androidx.compose.ui.graphics.Color.White else ScratchlistAmber,
                contentColor = if (active) ScratchlistAmber else androidx.compose.ui.graphics.Color.White,
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier.align(Alignment.TopEnd),
            ) {
                Text(
                    text = if (count > 99) "99+" else count.toString(),
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.padding(horizontal = 4.dp, vertical = 1.dp),
                )
            }
        }
    }
}

/**
 * Mode banner above the composer card while Send parks instead of delivering
 * (the web drawer's amber border + "held — not sent" pill, compacted).
 */
@Composable
private fun ScratchlistModeHint(modifier: Modifier = Modifier) {
    Surface(
        color = ScratchlistAmber.copy(alpha = 0.12f),
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, ScratchlistAmber.copy(alpha = 0.55f)),
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
        ) {
            Icon(
                HapiNoteGlyph,
                contentDescription = null,
                tint = ScratchlistAmber,
                modifier = Modifier.size(16.dp),
            )
            Text(
                text = stringResource(R.string.chat_scratchlist_mode_hint),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 8.dp),
            )
            Surface(
                color = ScratchlistAmber,
                contentColor = androidx.compose.ui.graphics.Color.White,
                shape = RoundedCornerShape(8.dp),
            ) {
                Text(
                    text = stringResource(R.string.chat_scratchlist_held_label),
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                )
            }
        }
    }
}

// -------------------------------------------------------- slash dropdown --

/**
 * Filtered command list above the input (web `Autocomplete.tsx` twin):
 * name + description rows, tap inserts `/name `.
 */
@Composable
private fun SlashCommandDropdown(
    suggestions: List<SlashCommand>,
    onSelect: (SlashCommand) -> Unit,
    modifier: Modifier = Modifier,
) {
    AutocompleteSurface(modifier) {
        LazyColumn(modifier = Modifier.heightIn(max = 240.dp)) {
            items(suggestions, key = { "${it.source}:${it.name}" }) { command ->
                AutocompleteRow(
                    leading = "/",
                    name = command.name,
                    description = command.description,
                    onClick = { onSelect(command) },
                )
            }
        }
    }
}

/**
 * Skills list above the input — same dropdown shell with the `$` glyph
 * (web renders `$name` labels in `Autocomplete`).
 */
@Composable
private fun SkillSuggestionDropdown(
    suggestions: List<SkillSummary>,
    onSelect: (SkillSummary) -> Unit,
    modifier: Modifier = Modifier,
) {
    AutocompleteSurface(modifier) {
        LazyColumn(modifier = Modifier.heightIn(max = 240.dp)) {
            items(suggestions, key = { it.name }) { skill ->
                AutocompleteRow(
                    leading = "$",
                    name = skill.name,
                    description = skill.description,
                    onClick = { onSelect(skill) },
                )
            }
        }
    }
}

/** Shared dropdown chrome (web `Autocomplete` container). */
@Composable
private fun AutocompleteSurface(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = RoundedCornerShape(12.dp),
        tonalElevation = 2.dp,
        modifier = modifier.fillMaxWidth(),
    ) {
        content()
    }
}

/** One suggestion row: `leading + name` and an optional 2-line description. */
@Composable
private fun AutocompleteRow(
    leading: String,
    name: String,
    description: String?,
    onClick: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Text(
            text = "$leading$name",
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        description?.takeIf { it.isNotBlank() }?.let { text ->
            Text(
                text = text,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.hapi.hint,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.surfaceContainerHighest)
}

// -------------------------------------------------------- mention dropdown --

/**
 * `@` mention rows above the input (B-M16a, web `Autocomplete.tsx` twin):
 * session chips (`@<title>` + `Session · <id8> [· active]`) ahead of file hits
 * (`@<fileName>` + path); tap swaps the active word for the insert text.
 */
@Composable
private fun MentionDropdown(
    suggestions: List<MentionSuggestion>,
    onSelect: (MentionSuggestion) -> Unit,
    modifier: Modifier = Modifier,
) {
    val mentionSuggestionsDescription = stringResource(R.string.chat_mention_suggestions)
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = RoundedCornerShape(12.dp),
        tonalElevation = 2.dp,
        modifier = modifier
            .fillMaxWidth()
            .semantics { contentDescription = mentionSuggestionsDescription },
    ) {
        LazyColumn(modifier = Modifier.heightIn(max = 240.dp)) {
            items(suggestions, key = { it.key }) { suggestion ->
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .combinedClickable(onClick = { onSelect(suggestion) })
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                ) {
                    Text(
                        text = suggestion.label,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = suggestion.description,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.hapi.hint,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.surfaceContainerHighest)
            }
        }
    }
}

// ------------------------------------------------------------- dictation --

/** Elapsed-time recording chip with a cancel affordance (discards the take). */
@Composable
private fun RecordingChip(
    startedAtMs: Long,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
    /** Injectable clock for previews. */
    now: () -> Long = System::currentTimeMillis,
) {
    var elapsedSec by remember(startedAtMs) {
        mutableLongStateOf(((now() - startedAtMs) / 1000).coerceAtLeast(0))
    }
    LaunchedEffect(startedAtMs) {
        while (true) {
            elapsedSec = ((now() - startedAtMs) / 1000).coerceAtLeast(0)
            delay(250)
        }
    }
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer,
        shape = RoundedCornerShape(12.dp),
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = stringResource(R.string.chat_recording, formatElapsed(elapsedSec)),
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 12.dp, top = 4.dp, bottom = 4.dp),
            )
            TextButton(onClick = onCancel) { Text(stringResource(R.string.chat_cancel)) }
        }
    }
}

/** `m:ss` elapsed-time label for the recording chip. */
internal fun formatElapsed(totalSeconds: Long): String {
    val minutes = totalSeconds / 60
    val seconds = totalSeconds % 60
    return "%d:%02d".format(minutes, seconds)
}

/**
 * Press-to-toggle mic: idle glyph → recording stop-square (error colors) →
 * spinner while starting/transcribing.
 */
@Composable
private fun MicButton(state: DictationState, onToggle: () -> Unit) {
    val recording = state is DictationState.Recording
    val busy = state is DictationState.Starting || state is DictationState.Transcribing
    ComposerActionButton(
        contentDescription = stringResource(
            if (recording) R.string.chat_composer_stop_recording else R.string.chat_composer_mic,
        ),
        onClick = onToggle,
        enabled = !busy,
        color = if (recording) {
            MaterialTheme.colorScheme.errorContainer
        } else {
            MaterialTheme.colorScheme.surfaceContainerHigh
        },
        contentColor = if (recording) {
            MaterialTheme.colorScheme.onErrorContainer
        } else {
            MaterialTheme.colorScheme.onSurfaceVariant
        },
    ) {
        when {
            busy -> CircularProgressIndicator(
                modifier = Modifier.size(16.dp),
                strokeWidth = 2.dp,
                color = MaterialTheme.hapi.hint,
            )
            recording -> Icon(StopGlyph, contentDescription = null, modifier = Modifier.size(18.dp))
            else -> Icon(MicGlyph, contentDescription = null, modifier = Modifier.size(19.dp))
        }
    }
}

// ---------------------------------------------------------------- actions --

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun PrimaryActionButton(
    state: ComposerUiState,
    attachments: List<ComposerAttachmentUi>,
    onSend: () -> Unit,
    onSendSteer: () -> Unit,
    onAbort: () -> Unit,
) {
    var steerMenuOpen by remember { mutableStateOf(false) }
    val hasText = state.text.isNotBlank()
    val hasDraft = hasText || attachments.isNotEmpty()
    // Attachments gate the send like the web: every chip must settle Ready
    // (uploading waits, failed must be retried or removed); a ready tray
    // allows an attachments-only send (wire: text or attachments required).
    val attachmentsBusy = attachments.any { it.status != ComposerAttachmentStatus.Ready }
    val attachmentsReady = attachments.isNotEmpty() && !attachmentsBusy
    val canSubmit = (hasText || attachmentsReady) && !attachmentsBusy && !state.isSending
    val action = when {
        state.isSending -> ComposerPrimaryAction.Sending
        state.canSteer && !hasDraft -> ComposerPrimaryAction.Stop
        else -> ComposerPrimaryAction.Send
    }

    Box {
        when (action) {
            ComposerPrimaryAction.Sending -> ComposerActionButton(
                contentDescription = stringResource(R.string.chat_composer_send),
                onClick = {},
                enabled = false,
                contentColor = MaterialTheme.hapi.hint,
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.size(18.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.hapi.hint,
                )
            }
            ComposerPrimaryAction.Stop -> ComposerActionButton(
                contentDescription = stringResource(R.string.chat_composer_abort),
                onClick = onAbort,
                color = MaterialTheme.colorScheme.error,
                contentColor = MaterialTheme.colorScheme.onError,
            ) {
                Icon(StopGlyph, contentDescription = null, modifier = Modifier.size(19.dp))
            }
            ComposerPrimaryAction.Send -> ComposerActionButton(
                contentDescription = stringResource(
                    if (state.routesToScratchlist) {
                        R.string.chat_composer_send_to_scratchlist
                    } else {
                        R.string.chat_composer_send
                    },
                ),
                onClick = onSend,
                // Steering cannot coexist with the park routing (the web
                // interceptor runs before any intent handling).
                onLongClick = if (state.canSteer && canSubmit && !state.routesToScratchlist) {
                    { steerMenuOpen = true }
                } else {
                    null
                },
                enabled = canSubmit,
                color = when {
                    !canSubmit -> MaterialTheme.colorScheme.surfaceContainerHigh
                    state.routesToScratchlist -> ScratchlistAmber
                    else -> MaterialTheme.colorScheme.primary
                },
                contentColor = when {
                    !canSubmit -> MaterialTheme.hapi.hint
                    state.routesToScratchlist -> Color.White
                    else -> MaterialTheme.colorScheme.onPrimary
                },
            ) {
                Icon(ArrowUpGlyph, contentDescription = null, modifier = Modifier.size(20.dp))
            }
        }
        if (action == ComposerPrimaryAction.Send) {
            DropdownMenu(expanded = steerMenuOpen, onDismissRequest = { steerMenuOpen = false }) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.chat_send_steer)) },
                    onClick = {
                        steerMenuOpen = false
                        onSendSteer()
                    },
                )
            }
        }
    }
}

private enum class ComposerPrimaryAction {
    Sending,
    Stop,
    Send,
}

// -------------------------------------------------------------- previews --

@Preview(showBackground = true)
@Composable
private fun ChatComposerPreview() {
    HapiTheme {
        Surface {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                ChatComposer(
                    state = ComposerUiState(text = "", isSending = false, canSteer = false),
                    onTextChange = {}, onSend = {}, onSendSteer = {}, onAbort = {},
                    dictation = DictationState.Idle,
                )
                ChatComposer(
                    state = ComposerUiState(text = "", isSending = false, canSteer = true),
                    onTextChange = {}, onSend = {}, onSendSteer = {}, onAbort = {},
                    onAddAttachment = {},
                    dictation = DictationState.Idle,
                )
                ChatComposer(
                    state = ComposerUiState(
                        text = "Run the tests and summarize failures\nThen propose the smallest safe fix.",
                        isSending = false,
                        canSteer = true,
                    ),
                    onTextChange = {}, onSend = {}, onSendSteer = {}, onAbort = {},
                    dictation = DictationState.Idle,
                )
                ChatComposer(
                    state = ComposerUiState(text = "Sending…", isSending = true, canSteer = false),
                    onTextChange = {}, onSend = {}, onSendSteer = {}, onAbort = {},
                    onAddAttachment = {},
                    attachments = listOf(
                        ComposerAttachmentUi(
                            id = "a1",
                            filename = "screenshot.png",
                            mimeType = "image/png",
                            sizeBytes = 1_843_200,
                            previewBytes = null,
                            status = ComposerAttachmentStatus.Ready,
                        ),
                    ),
                )
                // Full quick-action row: Files / Scratchlist / Park next to "+".
                ChatComposer(
                    state = ComposerUiState(
                        text = "Draft worth parking before closing the tab",
                        isSending = false,
                        canSteer = true,
                    ),
                    onTextChange = {}, onSend = {}, onSendSteer = {}, onAbort = {},
                    onAddAttachment = {},
                    onOpenFiles = {},
                    onOpenScratchlist = {},
                    onParkDraft = {},
                    dictation = DictationState.Idle,
                ChatComposer(
                    state = ComposerUiState(
                        text = "Holding this thought until the tests pass",
                        isSending = false,
                        canSteer = false,
                        routesToScratchlist = true,
                    ),
                    onTextChange = {}, onSend = {}, onSendSteer = {}, onAbort = {},
                    scratchlistCount = 120,
                    onToggleScratchlist = {},
                )
            }
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun AttachmentChipsComposerPreview() {
    HapiTheme {
        Surface {
            ChatComposer(
                state = ComposerUiState(text = "", isSending = false, canSteer = true),
                onTextChange = {}, onSend = {}, onSendSteer = {}, onAbort = {},
                onAddAttachment = {},
                attachments = listOf(
                    ComposerAttachmentUi(
                        id = "up",
                        filename = "IMG_20260818_133702.jpg",
                        mimeType = "image/jpeg",
                        sizeBytes = 2_411_000,
                        previewBytes = null,
                        status = ComposerAttachmentStatus.Uploading,
                    ),
                    ComposerAttachmentUi(
                        id = "ok",
                        filename = "build-log.txt",
                        mimeType = "text/plain",
                        sizeBytes = 48_500,
                        previewBytes = null,
                        status = ComposerAttachmentStatus.Ready,
                    ),
                    ComposerAttachmentUi(
                        id = "bad",
                        filename = "trace.bin",
                        mimeType = "application/octet-stream",
                        sizeBytes = 9_000_000,
                        previewBytes = null,
                        status = ComposerAttachmentStatus.Failed,
                    ),
                ),
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun RecordingComposerPreview() {
    HapiTheme {
        Surface {
            ChatComposer(
                state = ComposerUiState(text = "", isSending = false, canSteer = false),
                onTextChange = {}, onSend = {}, onSendSteer = {}, onAbort = {},
                dictation = DictationState.Recording(startedAtMs = System.currentTimeMillis() - 42_000),
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun SlashDropdownComposerPreview() {
    HapiTheme {
        Surface {
            ChatComposer(
                state = ComposerUiState(text = "/co", isSending = false, canSteer = false),
                onTextChange = {}, onSend = {}, onSendSteer = {}, onAbort = {},
                dictation = DictationState.Idle,
                slashSuggestions = listOf(
                    SlashCommand(
                        name = "compact",
                        description = "Clear conversation history but keep a summary in context",
                        source = "builtin",
                    ),
                    SlashCommand(
                        name = "context",
                        description = "Visualize current context usage as a colored grid",
                        source = "builtin",
                    ),
                    SlashCommand(name = "code-review", description = null, source = "project"),
                ),
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun MentionDropdownComposerPreview() {
    HapiTheme {
        Surface {
            ChatComposer(
                state = ComposerUiState(text = "@ref", isSending = false, canSteer = false),
                onTextChange = {}, onSend = {}, onSendSteer = {}, onAbort = {},
                dictation = DictationState.Idle,
                mentionSuggestions = listOf(
                    MentionSuggestion.SessionMention(
                        id = "3f9d2c1b8e7a4d60",
                        title = "Refactor auth flow",
                        key = "session:3f9d2c1b8e7a4d60",
                        label = "@Refactor auth flow",
                        description = "Session · 3f9d2c1b",
                        insertText = "See session \"Refactor auth flow\" (/sessions/3f9d2c1b8e7a4d60) for context.",
                    ),
                    MentionSuggestion.FileMention(
                        key = "@docs/auth.md",
                        label = "@auth.md",
                        description = "docs/auth.md",
                        insertText = "@docs/auth.md",
                    ),
                ),
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun ScheduledComposerPreview() {
    HapiTheme {
        Surface {
            ChatComposer(
                state = ComposerUiState(
                    text = "Wrap up the release notes and ping me",
                    isSending = false,
                    canSteer = false,
                ),
                onTextChange = {}, onSend = {}, onSendSteer = {}, onAbort = {},
                pendingSchedule = PendingSchedule.Preset("+30m"),
                onScheduleSelected = {},
                onClearSchedule = {},
                dictation = DictationState.Idle,
            )
        }
    }
}
