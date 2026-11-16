package app.hapi.companion.feature.chat.blocks

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.chat.LocalChatSettings
import app.hapi.companion.ui.markdown.Markdown
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.HapiTypography
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.AgentReasoningBlock
import app.hapi.protocol.chat.AgentTextBlock

/** Assistant prose: full-width markdown (the shared M2d1 renderer). */
@Composable
fun AgentTextBlockView(block: AgentTextBlock, modifier: Modifier = Modifier) {
    // History actions (fork-current at the latest boundary) render from the
    // transcript row wrapper, not here — see ChatTranscript.
    Markdown(text = block.text, modifier = modifier.fillMaxWidth())
}

/**
 * Extended thinking (iOS `AgentReasoningBlockView`), stack-noted: the
 * initial fold follows the Chat settings `reasoningCollapsed` preference.
 * A quiet chevron + label
 * that expands in place to the full reasoning Markdown. The body stays
 * subdued (75% opacity behind a hairline rule) because it is meta-content,
 * not the answer.
 */
@Composable
fun AgentReasoningBlockView(block: AgentReasoningBlock, modifier: Modifier = Modifier) {
    // Read outside the initializer: the rememberSaveable lambda is not
    // composable, and only the *initial* fold follows the preference anyway
    // (stack Chat settings `reasoningCollapsed`; Android ships collapsed).
    val chatSettings = LocalChatSettings.current
    var expanded by rememberSaveable(block.id) { mutableStateOf(chatSettings.reasoningCollapsed.not()) }
    val secondary = MaterialTheme.hapi.textSecondary
    val chevronRotation by animateFloatAsState(if (expanded) 90f else 0f, label = "reasoning-chevron")
    val stateLabel = stringResource(if (expanded) R.string.chat_reasoning_state_expanded else R.string.chat_reasoning_state_collapsed)

    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.hapi.reasoningBackground,
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .clip(RoundedCornerShape(8.dp))
                .clickable(role = Role.Button) { expanded = !expanded }
                .semantics { stateDescription = stateLabel }
                .heightIn(min = 32.dp)
                .padding(end = 8.dp)
                .testTag("reasoning-toggle"),
        ) {
            Icon(
                painter = painterResource(R.drawable.ic_sym_chevron_right),
                contentDescription = null,
                tint = secondary,
                modifier = Modifier.size(16.dp).rotate(chevronRotation),
            )
            Text(
                text = stringResource(if (expanded) R.string.chat_reasoning_expanded else R.string.chat_reasoning_collapsed),
                style = HapiTypography.rowSubtitle.copy(fontWeight = FontWeight.Medium),
                color = secondary,
                modifier = Modifier.padding(start = 4.dp),
            )
        }
        if (expanded) {
            Row(
                modifier = Modifier
                    .padding(start = 7.dp, top = 4.dp, bottom = 4.dp)
                    .height(IntrinsicSize.Min),
            ) {
                Box(
                    Modifier
                        .width(2.dp)
                        .fillMaxHeight()
                        .clip(RoundedCornerShape(1.dp))
                        .background(MaterialTheme.hapi.divider),
                )
                Markdown(
                    text = block.text,
                    modifier = Modifier
                        .padding(start = 12.dp)
                        .alpha(0.75f),
                )
            }
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun AgentTextBlockPreview() {
    HapiTheme {
        Surface {
            Column(modifier = Modifier.padding(12.dp)) {
                AgentTextBlockView(
                    AgentTextBlock(
                        id = "a1",
                        localId = null,
                        createdAt = 0,
                        invokedAt = null,
                        text = "The failing test was a **cursor regression**:\n\n" +
                            "1. `beforeSeq` lost its `beforeAt` half\n" +
                            "2. the hub returned `reset: true`\n\n" +
                            "```kotlin\nval cursor = MessagePosition(at, seq)\n```",
                        meta = null,
                    ),
                )
                AgentReasoningBlockView(
                    AgentReasoningBlock(
                        id = "r1",
                        localId = null,
                        createdAt = 0,
                        invokedAt = null,
                        text = "The user wants pagination fixed. Let me check the cursor pair first…",
                        meta = null,
                    ),
                )
            }
        }
    }
}
