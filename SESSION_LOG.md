# Session Log — 2026-08-14

Narrative record of how this project got built, for anyone (including future
us) picking it back up. Infra specifics (instance IDs, VPC/subnet/security
group IDs, credentials, hostnames) live in `SESSION_HANDOFF.md`, which is
intentionally **not** committed to this public repo -- see the note at the
bottom of this file for why.

## What got built

A browser-based batch RAW photo converter: drag-drop CR2/CR3/NEF/ARW/DNG/RAF
files, pick an output format (JPEG/WebP/PNG), optional resize + quality
controls, get a zip of converted files back. Node/Express backend, plain
HTML/CSS/JS frontend, no build step.

## The libraw-wasm dead end (worth documenting for anyone else hitting this)

The original plan was the `libraw-wasm` npm package for RAW decoding, since it
avoids needing a native build toolchain. It looked reasonable on paper: pure
WASM, published API, README claims Node.js support.

In practice, decode calls **hung forever** under plain Node (Express, no
timeout, no error) instead of ever resolving or rejecting. Root cause, found
via an isolated repro script outside Express/multer entirely:

- `libraw-wasm`'s worker script uses browser `Worker` globals
  (`self.onmessage`/`postMessage`), so it needs the `web-worker` npm package
  as a polyfill to run inside Node's `worker_threads` at all.
- Once running, its Emscripten-compiled loader tries to fetch its `.wasm`
  binary via `fetch()`, which fails on `file://` URLs in Node, then falls
  back to `XMLHttpRequest`, which doesn't exist in Node at all. The worker
  aborts almost immediately.
- Critically, `libraw-wasm`'s `LibRaw` class never wires up an error/exit
  handler on the underlying worker. When the worker dies, every in-flight
  call's promise just sits unresolved forever -- no error, no timeout, no
  signal that anything went wrong.
- This is very easy to misdiagnose as "the instance is too weak / decode is
  just slow" -- a stuck request looks identical to a slow one from the
  outside. The tell was CloudWatch: CPU utilization stayed under 9% the
  entire time a "decode" sat running for 15+ minutes, with CPU credits
  climbing rather than draining. Real compute work would show load; a dead
  worker waiting on an unsettled promise won't.
- Their own CI only validates decoding in headless Chromium, not plain
  Node -- so this isn't really a "Node-supported" package in practice despite
  what the README says.

## What replaced it

Native LibRaw, built from source (`dnf groupinstall "Development Tools"` +
standard autotools build), specifically its `dcraw_emu` sample CLI tool.
`server.js` shells out to it (`dcraw_emu -T -w -q 3 -o 1 -Z - <input>`,
TIFF to stdout) and pipes the result straight into `sharp`, which reads TIFF
natively -- no manual width/height/channel-count bookkeeping needed like the
raw-buffer approach would have required.

Result: a 26MP RAW file decodes in about 3 seconds, even on the smallest
practical EC2 instance size, using multiple cores via OpenMP. No Worker, no
wasm, no polyfill, no silent-hang failure mode.

## Other fixes made along the way

- **sharp CVE:** `npm audit` flagged a high-severity libvips vulnerability in
  sharp <0.35.0. Bumped to `sharp@^0.35.3`, which needs Node >=20.9 --
  documented via `engines` in `package.json`. The original test instance
  shipped with Node 18 (also past EOL) and was upgraded to Node 22.
- **Upload filename sanitization:** the multer disk-storage filename and the
  zip entry name were both built from the uploaded file's original name
  without sanitizing it first -- a crafted filename containing `../` could
  have escaped the intended temp-file or zip-entry path. Fixed by routing
  both through a `path.basename` + charset-allowlist helper before this app
  was ever exposed outside a private tunnel.
- **Auth:** the app originally had none. Before opening any public network
  access to it, added a minimal HTTP Basic Auth gate that reads credentials
  from environment variables and refuses to start if they're unset, so it
  can't accidentally end up running wide open.

## Going public, and adding a second user

After confirming the full `/convert` route worked end-to-end (not just the
`dcraw_emu` CLI in isolation), the app was opened up beyond the private SSM
tunnel: inbound access on its port was allowed from anywhere, and it's now
reachable over plain HTTP at the test instance's public address, gated by
HTTP Basic Auth. Terrence shared that URL with a friend to test with.

A second user (Christine) needed her own login rather than sharing
Terrence's. That meant extending the auth from a single hardcoded
username/password pair to a small multi-user scheme: one `APP_CREDENTIALS`
environment variable holding a comma-separated `user:pass` list, parsed into
a lookup map at startup. Same fail-closed behavior as before -- the server
still refuses to start if that variable isn't set.

Neither user's actual password is written down anywhere in this repo --
they were generated and handed over out of band, same as the AWS resource
IDs and hostname below.

**Known limitation, not yet addressed:** this is plain HTTP, not HTTPS, so
Basic Auth credentials cross the network in the clear. Acceptable for a
short-lived test with people you trust; would need real TLS (e.g. a
Cloudflare proxy, or a proper cert) before this becomes anything longer-lived
or more widely shared.

## UI refresh: jungle theme and rebrand

The reviewer this app is being built for is a bubbly documentarian, so the UI
got a deliberate personality pass: a bright, lively jungle-themed palette
(leafy greens, warm orange/yellow accents), a playful display font for the
headline, and a rebrand from the generic "RAW Photo Converter" title to "The
Saints of Short Creek RAW Photo Converter". Pure `public/index.html` +
`public/style.css` change, no server or JS changes. Originally shipped with
separate light and dark palettes (switching via `prefers-color-scheme`), but
simplified to a single forced-light palette so the branding renders
consistently for every viewer regardless of their device's theme setting.

## Stable public URL: custom domain + named Cloudflare Tunnel

The account-less Cloudflare "quick tunnel" used earlier has a real limitation:
no uptime guarantee, and the URL changes any time the tunnel process restarts
-- not viable to hand out as a permanent link. Replaced it with a real domain
on a named Cloudflare Tunnel, which gives a stable HTTPS URL that survives
restarts.

Along the way, a genuine deployment mistake surfaced and got fixed: while
generating the tunnel's connector install command from the Cloudflare
dashboard, the OS selector defaulted to Windows, and the connector install
command was run on a local Windows machine before the correct Linux command
for the actual server was ready. That put a second, non-functional connector
on the same tunnel -- one with nothing behind it on the expected port.
Cloudflare Tunnel spreads incoming traffic across every connector attached to
a tunnel, so once the correct connector (on the real server) also came
online, roughly half of all requests landed on the dead one and failed with a
502 error. Diagnosed by noticing the failures weren't intermittent load
issues but a clean ~50% split, checking the tunnel's connector list in the
dashboard, and confirming two connectors were attached where only one should
have been. Fixed by removing the stray connector; verified with several
consecutive successful requests afterward.

**Lesson for next time:** always double check which machine/OS a generated
install or setup command is about to run on before running it, especially
when a dashboard or wizard defaults to a guess (like "Windows") that may not
match the actual target server.

## Incremental load-test harness (2026-08-14, later same day)

With the reviewer flow settled, attention turned to a question nobody had
tested yet: how many RAW files can one `/convert` request actually handle
before something gives out, and what actually gives out first (memory, CPU,
disk, network, or just Node's own request timeout)? The app processes files
serially within a request with zero concurrency cap between separate
requests, and had no built-in instrumentation at all -- no memory logging, no
per-file timing -- so answering "where does it fail" meant building
observability from outside the app rather than adding it inside.

Two scripts were added under `loadtest/`:

- **`ramp-driver.ps1`** -- a PowerShell script that ramps batch size (files
  attached to a single `/convert` request) up a coarse sequence, watches for
  the first full-batch failure (a real crash/timeout, not the app's normal
  per-file error handling, which still returns a valid partial zip), then
  bisects to find the exact failing batch size. Classifies each step from the
  server's own response -- HTTP status, curl exit code, and whether the
  returned zip actually opens with the right number of entries -- rather than
  guessing from timing alone.
- **`observer.sh`** -- a small poll loop meant to run on the server itself
  during a ramp, logging one line a second: network throughput (interface
  byte counters only, not per-connection or content-level data), RAM,
  temp-storage usage, count of any leftover upload files, and whether the
  server process is still listening at all. Reusing a network-heartbeat
  approach worked out earlier in a separate discussion about watching for
  bandwidth surges at the infrastructure level, generalized here to also
  catch the more likely culprits (RAM headroom on a small instance, and
  whether temp storage is itself memory-backed).

Worth remembering for next time: this app's temp upload storage lives on a
memory-backed filesystem on the test instance, not a separate disk -- so "ran
out of disk" and "ran out of RAM" are not actually independent failure modes
here, they're the same resource. Also worth remembering: Node's default
request timeout (5 minutes) covers the entire time spent receiving the
upload, and with a single ~30MB test file taking on the order of tens of
seconds to upload from a home connection, a big-enough batch will likely hit
that timeout during upload, long before any server-side resource ceiling is
reached -- a client-uplink artifact that's easy to mistake for a real
capacity limit if the two aren't told apart. The driver script accounts for
this by running an identical control pass from the server itself (bypassing
the home uplink) rather than trusting a single external run.

As of this write-up the harness was built and the observer had been started
on the live instance, but the actual ramp hadn't run yet -- it needed a
one-time local permission adjustment first. That got resolved later the
same session (see below), and the harness went on to do its job.

## What the ramp actually found, and fixing the ramp itself first

Once unblocked, the ramp's first real run immediately reported every
request as a failure -- including a single-file request that should have
trivially succeeded. Two genuine bugs in the load-test driver itself
turned out to be masking any real signal from the server:

- The driver's own recorded exit code for its upload tool came back blank
  on every single run. Root cause: a well-known PowerShell quirk where a
  background-process handle needs to be explicitly touched right after
  starting it, and both its output streams need to be captured (not just
  one), or the exit code silently never gets recorded afterward.
- Every genuinely successful response was being flagged as corrupt. This
  first looked like a timing race (the response file being checked before
  the upload tool had fully released it), and was addressed as one before
  the real cause turned up: Windows PowerShell doesn't load the .NET zip
  library by default, so every validation check was throwing "type not
  found" -- which, if you're not looking closely, produces exactly the
  same symptom as a corrupt file. The fix was a single missing library
  load, not a timing fix at all.

Worth remembering: a retry loop can silently paper over a bug that isn't
actually a timing issue. Surfacing the *actual* exception message before
reaching for a retry/backoff fix caught this one.

With the driver itself trustworthy, the real finding came quickly: a
25-file batch failed reliably at almost exactly 5 minutes, while 20 files
succeeded cleanly. Server health checks all came back clean (no crash, no
memory pressure, no restart) -- ruling out a resource ceiling. Five
minutes is the framework's own default limit on how long it will wait to
receive a request body, and it had never been overridden. Not a capacity
problem at all -- a default nobody had looked at.

## Overlapping upload and processing

The app was processing an entire batch strictly in two phases: wait for
every file to finish uploading, *then* start converting any of them. That
meant a large batch's total time was upload time plus processing time,
stacked, even though the actual conversion work for one file is fast
(seconds) compared to the several seconds it takes just to upload one over
a home connection.

Rewriting the upload handling to stream the request instead of buffering
it first let each file's conversion begin the moment *that* file finished
arriving, running concurrently with whatever file was uploading next. This
needed the format/quality/resize options to be known before any file
starts arriving (the streaming parser processes the request in the order
it was sent), so the upload form was changed to send those options first.
Net effect, confirmed by measurement, not just architecture: per-file cost
dropped by roughly a quarter, holding steady across a range of batch
sizes.

**A real memory leak turned up as a side effect of this rewrite, and got
fixed:** if a client's connection drops mid-upload, the file still being
written previously never got cleaned up -- it just sat there permanently.
Upload temp storage on the test instance happens to live on the same
memory pool as the app itself, so repeated dropped connections were slowly
and silently eating available memory across a testing session, to the
point of leaving well under 10% of system memory free before it was
caught. Fixed by explicitly tracking every file a request creates and
cleaning all of them up the moment a connection drops, not just on normal
completion -- verified afterward by deliberately dropping a connection
mid-batch and confirming nothing was left behind.

With the timeout default removed (deliberately disabled rather than just
raised, since a legitimate batch's upload time scales with how many files
are in it -- there's no single safe fixed number to replace it with) and
the batch-size cap raised accordingly, a 50-file batch that would have
hit the old 5-minute wall partway through now completes cleanly end to
end.

## Parallel uploads, and how far that idea actually goes

A single upload connection turned out not to be using all of the
available bandwidth on the test connection used for development -- direct
measurement (two files uploaded at once vs. sequentially) showed roughly
a 30% time savings from simply running two uploads at the same time
instead of one after another. That got built into the browser UI: a
batch now splits into two groups and uploads both concurrently as two
independent requests, each producing its own downloaded zip. No
server-side changes were needed for this -- each half is a completely
self-contained request.

The natural follow-up question -- would more than two parallel uploads
help further, or would splitting traffic across genuinely separate
server processes "trick" a home router into allocating more bandwidth --
got tested directly rather than assumed. It doesn't. Four simultaneous
uploads performed worse than two. Splitting traffic across two separate
server processes performed about the same as splitting across two
connections to one process. Combining both (two processes, two
connections each) performed *worse* than a single connection alone. The
practical, measured conclusion: two simultaneous connections is the real
sweet spot for the connection this was tested on, and pushing further in
that direction -- more streams, more destinations, or both -- doesn't
help and can actively hurt. This isn't treated as a closed question,
though -- there's an open interest in revisiting parallel-upload
behavior again in the future with a different angle, so it's parked
here rather than considered fully settled.

Testing the two-separate-processes variant required briefly opening an
additional network port on the test infrastructure for the duration of
the test, fully reverted afterward. Worth stating plainly since this app
is being built for someone else to use: nothing about this testing ever
touched or reconfigured anything on an end user's own device, network, or
router -- everything tested and changed was entirely on the
infrastructure side.

## Why SESSION_HANDOFF.md isn't in this repo

This repo is public (intentionally, so it can be pulled from another AWS
account for testing). `SESSION_HANDOFF.md` has real AWS resource identifiers
for the instance this was developed and tested on. Those alone don't grant
access to anything without real AWS credentials, but they're still
infrastructure fingerprinting information not worth publishing by default,
so that file stays local-only and gitignored. One early commit briefly
included it before this policy was applied consistently -- that historical
commit still contains those resource IDs (git history isn't rewritten
lightly), but no credentials or AWS account ID were ever committed at any
point in this repo's history.

## Per-photo format time: instrumenting before guessing

With upload speed already reasonably optimized (see "Parallel uploads"
above), attention turned to the other half of the per-photo cost: the
actual RAW decode + resize/encode work. The ~3-second figure quoted earlier
in this log turned out to be a bare command-line measurement, not something
the running app had ever actually measured about itself -- the app also
buffers the decoded image in memory, re-parses it for resizing, and zips the
result, none of which had ever been timed separately. Before tuning
anything, per-file decode and encode timing (plus a batch-level total) got
added directly to the server so a future run can show the real split instead
of assuming which stage is slow.

## Rethinking how to test CPU count vs. RAM

The original plan for sizing tests was to compare a few different cloud
instance sizes directly. That turned out to be the wrong instrument: cloud
instance families bundle CPU count and RAM together in ways that make it
hard to change one without the other, and comparing across families that
decouple them also changes CPU generation, muddying any result. The better
approach settled on was to provision one instance large enough to cover the
full range being tested, then use OS-level resource controls (cgroups) to
independently dial CPU count and memory ceiling up and down within that one
box -- a real isolated, then combined, test of both variables, with one
important trap noted for next time: throttling CPU time isn't the same as
restricting visible core count, and only the latter actually tests what
"fewer processors" is supposed to mean.

Along the way, a real latent bug got spotted (not yet fixed): the server
sizes its internal decode concurrency off the host's total core count at
startup, which would silently misbehave under a deliberately core-restricted
test environment -- it's the kind of thing that's easy to miss until you
actually try to constrain a box's visible CPUs and watch the app ignore the
constraint.

## Deciding to isolate testing into its own AWS account

While sketching an "only run the server when someone's actually using it"
idea for cost and security reasons, it became clear that the shared AWS
permissions setup this project's test instance currently borrows is also
used by unrelated infrastructure elsewhere. Widening those permissions for
this project's needs would have meant touching that unrelated
infrastructure's access too. Rather than being careful about scoping every
future permission change by hand, the decision was made to do upcoming
sizing/load testing in a completely separate AWS account instead -- a hard
boundary rather than a discipline to maintain. That also makes any future
testing's cost trivial to see on its own, and shrinks how much stays
network-reachable at any given time. Not yet executed -- the next session's
first job is standing that account up before any further server-sizing
testing happens.
