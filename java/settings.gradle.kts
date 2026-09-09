pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

plugins {
    // Auto-provisions a JDK 17 toolchain if one isn't already installed locally, so
    // `./gradlew build` works out of the box regardless of what JDK a contributor has on PATH.
    id("org.gradle.toolchains.foojay-resolver-convention") version "0.9.0"
}

rootProject.name = "deja"

include("core")
include("junit5")
include("cli")

// Directories stay short (core/, junit5/); published artifact ids carry the project's name
// (deja-core, deja-junit5) so they're unambiguous on Maven Central.
project(":core").name = "deja-core"
project(":junit5").name = "deja-junit5"

// Not published to Maven Central (see cli/build.gradle.kts) -- an application entrypoint, not
// a library other projects depend on -- so it keeps the short "cli" project name too.
