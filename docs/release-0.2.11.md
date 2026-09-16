# Tracing 0.2.11: Windows durable upload queue

Windows rejects fsync on a read-only file handle. The shared atomic JSON writer
opened its temporary file with r, so queue creation could fail before the uploader
started. The same writer also handles upload status and byte checkpoints.

The writer now opens the file with r+ before syncing, closes the handle before
rename, and cleans up temporary files if writing, opening, syncing, or renaming
fails. The previous queue remains available when a replacement fails before rename.
Turn acknowledgements already use a writable append handle.

The Windows hook command uses a Node launcher that reads PLUGIN_ROOT directly
from the process environment, avoiding shell-specific variable expansion. The
POSIX command is unchanged. Codex supports the commandWindows override; see
[the official hook reference](https://developers.openai.com/codex/hooks).
The startup regression executes the selected command through the native platform
shell; it also exercises the Windows launcher on Linux.

Five regression cases enforce Windows fsync behavior on real temporary files and
exercise worker startup, checkpoints, status, failure cleanup, and retry. CI runs
the complete lint, typecheck, build verification and test suite on both Ubuntu
and Windows with Node 22. POSIX permission assertions apply only on POSIX; Windows
continues using its existing directory ACLs.

Local validation: 113 tests passed, one optional stress test skipped; TypeScript,
formatting, distribution build, and whitespace checks passed. Native Windows CI
results must be checked separately after publication.

This release includes the stable upload identities from 0.2.10. Existing user
rollouts and ledgers are not deleted or automatically replayed.
