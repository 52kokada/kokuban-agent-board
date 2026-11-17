# Local phone voice

Record, stop, review the transcript in the composer, then Send. Audio remains a
normal kept attachment. The agent receives the reviewed text and the original
attachment's absolute path through the existing conversation provider flow.
No transcription API or API key is used.

Small multilingual runs first on CPU/int8 with eight threads. Turbo refines in
the background; its result replaces text only while the draft revision still
matches. Editing, removing the audio or sending protects that text from later
results. A conflicting result offers **Use transcript** as an explicit choice.
Send becomes available after the first pass; it sends exactly the displayed text,
without waiting for turbo. Missing Python/model/dependencies show **Voice
unavailable** and leave the audio available to send.

## Install

Python **3.12** must already be installed. From a built checkout:

```powershell
npm run build
node dist/src/cli.js phone voice install
```

The installer creates `%LOCALAPPDATA%/kokuban/voice/venv`, installs the exact
versions in `src/voice/runtime/requirements-lock.txt`, and downloads both pinned
models to `model-small` and `model-turbo` beside the venv. Downloads total about
2 GB of weights. This PC is already prepared: a new stable venv was installed
and the pinned model snapshots from the accepted spike were copied there.

Equivalent manual setup (run the commands individually):

```powershell
py -3.12 -m venv "$env:LOCALAPPDATA/kokuban/voice/venv"
& "$env:LOCALAPPDATA/kokuban/voice/venv/Scripts/python.exe" -m pip install -r src/voice/runtime/requirements-lock.txt
& "$env:LOCALAPPDATA/kokuban/voice/venv/Scripts/python.exe" src/voice/runtime/download-model.py --model small --model-dir "$env:LOCALAPPDATA/kokuban/voice/model-small"
& "$env:LOCALAPPDATA/kokuban/voice/venv/Scripts/python.exe" src/voice/runtime/download-model.py --model large-v3-turbo --model-dir "$env:LOCALAPPDATA/kokuban/voice/model-turbo"
```

Pinned small: `Systran/faster-whisper-small` at
`536b0662742c02347bc0e980a01041f333bce120`. Turbo:
`mobiuslabsgmbh/faster-whisper-large-v3-turbo` at
`0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf`.
faster-whisper 1.2.1, CTranslate2 4.8.3, PyAV 16.1.0; the lock pins all dependencies.
PyAV supplies decoding libraries; no external ffmpeg is needed at runtime.

Runtime uses absolute local model directories, `local_files_only=True`, and
offline Hugging Face mode. The installer is the only download step. Windows
children use `windowsHide: true`, piped stdio, no shell and no detached process.

## Lifetime and limits

The gateway owns one lazy small child and one lazy turbo child. Creating the
board/gateway starts neither. The first voice upload starts small. Small remains
resident; turbo unloads after ten idle minutes and reloads only for another note.
The board awaits worker shutdown before closing conversations. A previously ready
worker restarts with backoff after a crash, without replaying failed audio jobs.
Broken startup stops retrying and reports unavailable instead of spawning forever.

Four active jobs maximum, 64 retained results, one-hour result expiry on admission.
Results are scoped to the paired device. Audio is bounded by existing 10 MB upload
limits and 300 decoded seconds. File paths come only from saved conversation
attachments, never a phone-supplied filesystem path; Python resolves junctions and
rejects escapes. AAC MP4, fragmented MP4 and WebM/Opus decode locally. The earlier
spike physically verified Safari AAC/MP4 from Alex's iPhone.

`POST /phone/upload?...&voice=1` persists `voiceNote: true`, returns the attachment
and voice job. `GET /phone/voice?id=...` returns small/refined results. Existing
phone identity, pairing, origin and CSRF gates apply. The composer polls the job
without blocking upload or navigation. Unmarked photos/files do not start ASR.
Results are ephemeral across a board restart; saved audio is retained.

## Evidence, 2026-10-20

`npm test`: **251 passed, 3 skipped, 0 failed** (254 total). This includes 12
production worker protocol/lifecycle tests, four integration/revision tests and
authenticated phone API coverage. Tests cover lazy start, owner scoping, bounded
admission, two passes, turbo unload/reload, missing installation, original
attachment retention, retry/crash/backoff/shutdown and edited/removed draft guards.

On this i9-13900KF, CPU/int8, eight threads, two 30-second English/Japanese clips:

| Measurement | Result |
|---|---|
| Small inference, English / Japanese | 5.80 s / 4.97 s |
| Turbo inference, English / Japanese | 5.71 s / 6.00 s |
| First cold small result, including load | 9.71 s |
| Cold two-pass completion | 17.67 s English; 13.20 s Japanese with small warm |
| Small retained working set | about 355–359 MiB |
| Turbo retained working set | about 908 MiB |
| Sampled busy RSS, small / turbo | about 517 MiB / 1136 MiB |
| Process peak during model load, small / turbo | about 691 MiB / 1876 MiB |
| Idle CPU, both processes over a 2.1 s sample | 0 CPU seconds each |

Peak load can temporarily total roughly 2.2 GiB with both children present.
Turbo unloading returns to small-only residency. Exact per-pass measurements are
in [resources.json](phone-voice/resources.json); other PC work affects timings.
The measurement used a shortened idle timeout between clips; production is ten
minutes. MKL stays disabled and OpenMP waits are passive to avoid idle spinning.

Desktop check used the actual client and production worker service through the
owner-only tailnet HTTPS `/voice-check` path on a separate port, with synthetic
conversation data (no production pairing or agent access). A real AAC upload
filled 277 transcript characters, enabled Send after small, then refined. A real
typed correction was sent with one kept audio path. Editing during the next
refinement remained intact with **Use transcript** visible; see
[revision-guard.png](phone-voice/revision-guard.png). This is desktop evidence,
not a new physical iPhone recording check. The one iPhone card follows live merge.
The temporary path/server and both measured Python children were stopped after
QA. Serve matched its exact pre-test snapshot; the task-opened browser tab was
closed and the remaining inventory preserved other sessions' tabs.

## Code and release handoff

- `src/voice/service.ts`: lazy two-pass lifecycle and bounded, device-scoped jobs.
- `src/voice/runtime/`: accepted spike worker/adapter plus pinned installer assets.
- `src/voice/install.ts`, `src/cli.ts`: `kokuban phone voice install`.
- `src/phone/routes.ts`, `src/phone/shell.ts`: upload marker, results, editable draft.
- `scripts/copy-voice.mjs`: copies non-TypeScript runtime assets into `dist/src`.

Lotus fast-forwarded main to `fc460f8`, reviewed the authenticated routes, bounded
worker lifetime and draft revision guards, and ran the full checks: **254 Node
tests passed, no skips or failures**; native core **56 passed, one optional
live-board test skipped**. One announced board restart activated the build.
Backup: `%LOCALAPPDATA%/kokuban/activation-backups/phone-1792525838368`.

The real tailnet `/phone/app.js` and `/phone/sw.js` each returned 200 and matched
the built voice client and preserved push worker. Existing iPhone device IDs,
token hashes and revocation state were preserved; loopback still refuses with
403. Both local model directories and the stable Python executable were present.
No voice Python worker existed immediately after activation, confirming lazy
startup. The untracked chief design draft was left untouched.

Beck owns the single physical-iPhone voice card following live confirmation.
Test a short English/Japanese note, edit it while Refine runs, and send once.
Keep the original audio and reviewed text. Physical iPhone acceptance remains
pending and is separate from the desktop AAC evidence above.
