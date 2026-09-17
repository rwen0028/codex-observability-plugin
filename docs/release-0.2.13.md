# Tracing 0.2.13: respect CODEX_HOME for Langfuse configuration

The installer wrote langfuse.json to the selected Codex home, but the tracing
plugin always read it from ~/.codex. SolidAgent and other applications using
independent homes therefore could not use the installed configuration.

The plugin now reads CODEX_HOME/langfuse.json when CODEX_HOME is nonblank, and
otherwise uses ~/.codex/langfuse.json. It does not fall back to or merge credentials
from the default home. A user-home working directory no longer reintroduces the
default global config through the project layer. Explicit project files and
environment variables retain their existing precedence.

Regression coverage includes a SolidAgent-style directory, default-home isolation,
missing/invalid/partial configurations, blank CODEX_HOME, a user-home working
directory, and project/environment overrides. Authentication and support-context
paths continue using the same selected home.

The Stop hook definition and upload identities are unchanged. Install and run
Codex with the same CODEX_HOME; restart the application/session after updating
its plugin to load this version.

Validation on 2026-09-17: 120 tests passed, one optional stress test skipped.
TypeScript, formatting, bundle build, and whitespace checks passed. A local
end-to-end run of the built Stop hook used a SolidAgent-shaped independent home
with all Langfuse environment overrides removed. The detached worker delivered
two OTLP spans (one turn and one generation) with the selected file's fixture
credentials to a loopback collector, and committed its checkpoint with status ok.
No model provider or production Langfuse was used for that validation.
