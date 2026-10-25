import java.io.File
import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// ---------------------------------------------------------------------------
// Web dist injection (bundled fallback layer of the three-layer static
// serving: OTA dir > bundled assets > network).
//
// Nothing is ever copied into app/src — the dist and its generated manifest
// land in build/generated/web-dist which is added as an extra assets srcDir,
// so the source tree stays clean and git never sees the 9.9 MB bundle.
// ---------------------------------------------------------------------------

/**
 * The sibling web app's build output (repo root /web/dist).
 *
 * NOTE: `layout.projectDirectory.dir("../web/dist")` is NOT usable here —
 * Gradle's Directory.dir() does not honor `..` and silently re-anchors the
 * path inside the project dir. Anchor on the repo root instead.
 */
val webDistDirFile = File(rootDir.parentFile, "web/dist")
val webDistDir = objects.directoryProperty().also { it.set(webDistDirFile) }

/** Generated assets root; merged into the APK next to app/src/main/assets. */
val generatedWebDistDir = layout.buildDirectory.dir("generated/web-dist")

val syncWebDist =
    tasks.register<Sync>("syncWebDist") {
        group = "hapi-web"
        description = "Copies the sibling web/dist into the generated assets dir (bundled layer, served as assets/webdist/<rel>)."
        from(webDistDir)
        into(generatedWebDistDir.map { it.dir("webdist") })
    }

// Configuration-cache-safe fail-loud gate: a compiled task class (script
// doFirst lambdas cannot be serialized into the CC state). Runs before the
// copy/manifest tasks whenever the APK actually needs the bundled dist.
val checkWebDist =
    tasks.register<CheckWebDistTask>("checkWebDist") {
        distPath.set(webDistDirFile.absolutePath)
    }

/**
 * Writes `webdist-manifest.json` — the definitive list of every relative
 * path in the bundled dist (note: this is the dist listing, NOT the sw.js
 * precache list; e.g. KaTeX fonts and sw.js itself are not precached but
 * must be servable from the bundle). The runtime loads it from assets and
 * uses it as the static whitelist + restricted enumeration for asset opens.
 */
val generateWebDistManifest =
    tasks.register<GenerateWebDistManifestTask>("generateWebDistManifest") {
        group = "hapi-web"
        description = "Generates assets/webdist-manifest.json (relative path list) from web/dist."
        webDist.set(webDistDir)
        manifestFile.set(generatedWebDistDir.map { it.file("webdist-manifest.json") })
    }

// Signing-secret resolution, mirroring ../android/app verbatim: gradle
// property (CLI -P or user-global ~/.gradle/gradle.properties), then
// environment (CI secrets), then android-web/local.properties (the
// conventional gitignored machine-local home — not part of gradle's own
// property chain, hence loaded explicitly).
val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

fun signingSecret(property: String, env: String): String? =
    (findProperty(property) as String?)?.takeIf { it.isNotBlank() }
        ?: System.getenv(env)?.takeIf { it.isNotBlank() }
        ?: localProperties.getProperty(property)?.takeIf { it.isNotBlank() }

android {
    namespace = "run.hapi.web"
    // Toolchain mirrors ../android/app (compileSdk 36 / minSdk 26 / JVM 17).
    compileSdk = 36

    defaultConfig {
        applicationId = "run.hapi.web"
        minSdk = 26
        targetSdk = 36
        // Version injection mirrors ../android/app exactly: CI passes
        // -PhapiVersionCode/-PhapiVersionName (the same convention the
        // `android` CI job uses); local defaults keep the shell buildable.
        versionCode = providers.gradleProperty("hapiVersionCode").map { value ->
            value.toInt().also { require(it > 0) { "hapiVersionCode must be positive" } }
        }.orElse(1).get()
        versionName = providers.gradleProperty("hapiVersionName").orElse("0.30.7").get()
    }

    // Release signing mirrors ../android/app: the SAME fork upload keystore,
    // resolved from gradle properties (-P / ~/.gradle/gradle.properties),
    // environment (CI secrets), or android-web/local.properties. All unset →
    // unsigned release (local dev needs no secrets); CI signs with the same
    // constant identity as the native APK so both upgrade cleanly.
    signingConfigs {
        val keystorePath = signingSecret("hapiUploadKeystore", "HAPI_UPLOAD_KEYSTORE")
            ?.replaceFirst(Regex("^~"), System.getProperty("user.home"))
        if (keystorePath != null) {
            create("release") {
                storeFile = File(keystorePath)
                storePassword = signingSecret("hapiUploadKeystorePassword", "HAPI_UPLOAD_KEYSTORE_PASSWORD")
                keyAlias = signingSecret("hapiUploadKeyAlias", "HAPI_UPLOAD_KEY_ALIAS") ?: "upload"
                keyPassword = signingSecret("hapiUploadKeyPassword", "HAPI_UPLOAD_KEY_PASSWORD")
                    ?: signingSecret("hapiUploadKeystorePassword", "HAPI_UPLOAD_KEYSTORE_PASSWORD")
            }
        }
    }

    sourceSets {
        getByName("main") {
            // Generated assets (webdist/ + webdist-manifest.json) merge into
            // the APK alongside app/src/main/assets.
            assets.srcDir(generatedWebDistDir)
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// AGP sees the generated dir but not the tasks that fill it — wire them into
// every variant's asset merge step (mergeDebugAssets / mergeReleaseAssets).
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach {
    dependsOn(checkWebDist, syncWebDist, generateWebDistManifest)
}

// Lint tasks also traverse the assets source dirs (implicit-dependency
// validation otherwise fails the build on them).
tasks.matching { it.name.contains("Lint", ignoreCase = true) }.configureEach {
    dependsOn(checkWebDist, syncWebDist, generateWebDistManifest)
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.security.crypto)
    implementation(libs.okhttp)
    implementation(libs.androidx.webkit)
    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.kotlinx.coroutines.android)

    // JVM unit tests: pairing validation / URL normalization / boot URL
    // assembly / static router / sw.js parsing / OTA plan+prune.
    testImplementation(libs.junit)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.kotlinx.coroutines.test)
}

/** Fail-loud gate: refuses to package an APK without a bundled web dist. */
abstract class CheckWebDistTask : org.gradle.api.DefaultTask() {
    @get:org.gradle.api.tasks.Input
    abstract val distPath: org.gradle.api.provider.Property<String>

    @org.gradle.api.tasks.TaskAction
    fun check() {
        val dir = File(distPath.get())
        if (!dir.isDirectory) {
            throw GradleException(
                "web/dist not found at $dir — build the web app first " +
                    "(cd web && bun install && bun run build), then rebuild android-web.",
            )
        }
    }
}

/** Builds the runtime whitelist manifest from the web/dist file listing. */
@org.gradle.api.tasks.CacheableTask
abstract class GenerateWebDistManifestTask : org.gradle.api.DefaultTask() {
    @get:org.gradle.api.tasks.InputDirectory
    @get:org.gradle.api.tasks.Optional
    @get:org.gradle.api.tasks.PathSensitive(org.gradle.api.tasks.PathSensitivity.RELATIVE)
    abstract val webDist: org.gradle.api.file.DirectoryProperty

    @get:org.gradle.api.tasks.OutputFile
    abstract val manifestFile: org.gradle.api.file.RegularFileProperty

    @org.gradle.api.tasks.TaskAction
    fun generate() {
        val dir = webDist.get().asFile
        if (!dir.isDirectory) {
            throw GradleException(
                "web/dist not found at $dir — build the web app first " +
                    "(cd web && bun install && bun run build), then rebuild android-web.",
            )
        }
        val paths =
            dir.walkTopDown()
                .filter { it.isFile }
                .map { it.relativeTo(dir).invariantSeparatorsPath }
                .filter { it != "sw.js" } // sw.js itself is fetched fresh by the OTA layer
                .sorted()
                .toList()
        val json = buildString {
            append("{\n  \"paths\": [")
            paths.forEachIndexed { i, p ->
                append(if (i == 0) "\n" else ",\n")
                append("    \"")
                append(p.replace("\\", "\\\\").replace("\"", "\\\""))
                append('"')
            }
            if (paths.isNotEmpty()) append("\n  ")
            append("]\n}\n")
        }
        val out = manifestFile.get().asFile
        out.parentFile.mkdirs()
        out.writeText(json)
        logger.lifecycle("webdist-manifest.json: {} bundled paths (from {})", paths.size, dir)
    }
}
