package app.hapi.companion.feature.share

import android.content.Intent
import android.net.Uri
import androidx.core.content.IntentCompat

/**
 * The only file in the share feature that touches `android.content`. Flattens
 * a platform Intent into primitives and delegates every decision to the pure
 * [ShareIntents.parse].
 *
 * EXTRA_STREAM comes from up to three places depending on sender: the single
 * [Intent.EXTRA_STREAM] parcel, the [Intent.EXTRA_STREAM] ArrayList (SEND_MULTIPLE),
 * and the ClipData some OEMs/apps use instead — all are merged, in that order,
 * and deduplicated by [ShareIntents].
 */
object SystemShareReader {

    fun read(intent: Intent?): ShareHandoff? {
        intent ?: return null
        if (!ShareIntents.isShareAction(intent.action)) return null
        return ShareIntents.parse(
            action = intent.action,
            subject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT),
            text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT),
            streams = readStreams(intent),
        )
    }

    private fun readStreams(intent: Intent): List<String?> {
        val uris = mutableListOf<Uri>()
        IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let(uris::add)
        IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
            ?.let(uris::addAll)
        // Some senders attach files only as ClipData; merge rather than choose.
        intent.clipData?.let { clip ->
            for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(uris::add)
        }
        return uris.map(Uri::toString)
    }
}
