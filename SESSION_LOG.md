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
