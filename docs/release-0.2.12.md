# Tracing 0.2.12: Windows uploads with the existing hook identity

This release retains the Windows r+ fsync fix, temporary-file cleanup, native
Windows CI configuration, and stable retry identities from 0.2.10.

It restores the original hook definition. Codex already substitutes PLUGIN_ROOT
before launching the platform shell, so a separate commandWindows override is
unnecessary. Keeping the previous command avoids an unnecessary change to its
trust identity for users upgrading from 0.2.10 or earlier.

The hook regression now reproduces that substitution and executes the bundled
hook from a plugin directory containing both spaces and non-ASCII characters.
The fsync regressions still enforce Windows behavior even when run on Linux.

Validation: 112 local tests passed, one optional stress test skipped; TypeScript,
formatting, bundle build, and whitespace checks passed. GitHub CI is configured
for Ubuntu and Windows, but native Windows execution must be verified separately
when a workflow run is available.

Reference: [Codex hook discovery](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/discovery.rs).
