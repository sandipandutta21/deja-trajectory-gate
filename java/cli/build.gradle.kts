plugins {
    id("dev.deja.java-conventions")
    application
}

description = "deja CLI: record/replay/verify/diff/redact are TS-only for now -- this module ships trajectory/gate, the HTTP replay server, and agent process lifecycle Trajectory Gate needs."

application {
    mainClass.set("dev.deja.cli.Main")
}

dependencies {
    implementation(project(":deja-core"))

    // deja-core deliberately keeps Jackson `implementation`-scoped (an internal detail, not
    // part of its public API), so it isn't visible here transitively -- this module's own HTTP
    // server needs to parse/write raw JSON-RPC bodies directly, so it declares the same
    // version explicitly, same as deja-junit5's test fixtures do.
    implementation("com.fasterxml.jackson.core:jackson-databind:2.22.2")
}
