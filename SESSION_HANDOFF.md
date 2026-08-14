# RAW Photo Converter — Session Handoff

**Purpose:** continuity for this project across sessions. Browser-based app that
takes DSLR RAW photos (CR2, NEF, ARW, DNG, etc.) and converts them to JPEG/WebP/PNG
with resize + quality controls, batch processing, zip download.

**Last updated:** 2026-08-13, right after the AWS instance was provisioned and
Node.js installed — no application code written yet.

---

## Decisions made

- **Architecture:** local server backend (not fully client-side WASM-in-browser).
  Browser is just the UI; a Node/Express server does the actual conversion work.
- **RAW decode library: `libraw-wasm`** (github.com/ybouane/LibRaw-Wasm) — real
  LibRaw demosaicing via WASM, no native compiler toolchain needed. Chosen over
  `lightdrift-libraw` (native addon, still alpha, needs node-gyp/Visual Studio Build
  Tools on Windows) and `libraw.js` (no Windows prebuilt binaries) and `dcraw.js`
  (older/less maintained decode quality).
- **Resize/encode: `sharp`** — takes the decoded RGB buffer from libraw-wasm,
  handles resize + JPEG/WebP/PNG encoding. Ships Windows-compatible prebuilt
  binaries, no native build pain.
- **Zip bundling: `archiver`** (planned, not yet installed) — for batch download
  of converted results as a single zip.
- **Required features:** batch processing (many files in one go) + zip download,
  resize/quality/format controls, true RAW demosaic decode (not just extracting
  the camera's embedded preview JPEG).

## Where it runs: AWS, not local Windows machine

Terrence's Windows machine doesn't have Node.js installed and he opted to run this
on a **new, separate AWS EC2 instance** rather than install Node locally or reuse
an existing prod box. Explicitly **not** the same instance as propSpider/rig-redesign
production infra (`Downloads\rig-redesign`) — kept isolated on purpose.

- **Instance ID:** `i-07e73c7732c822f18` (tag `Name=raw-converter-test`)
- **Region/AZ:** us-east-1, us-east-1a
- **Type:** t3.small (2 vCPU / 2GB RAM) — deliberately minimal/throwaway spec,
  chosen because Terrence said this instance is temporary and **will eventually be
  migrated to another AWS instance**. Don't over-invest in this box's setup being
  permanent.
- **VPC/Subnet:** default VPC `vpc-017f0ed2d88a29dff`, subnet
  `subnet-0ec115f05b12465a1` (public subnet, needed for SSM agent outbound access)
- **Security group:** `sg-06ce2c9102b4bcbb2` (`raw-converter-sg`) — **no inbound
  rules at all**. Access is SSM-only, not reused from `rig-test-desktop`'s SG
  (that one has RDP open for a different, unrelated purpose).
- **IAM:** reuses existing `rig-test-desktop-profile` instance profile (SSM-only
  permissions) rather than creating a new IAM role, per Terrence's choice.
- **Key pair:** none — no SSH access, SSM Session Manager only.
- **Access method:** SSM port forwarding (`aws ssm start-session --document-name
  AWS-StartPortForwardingSession`) from Terrence's machine to reach the browser UI
  once the server is running. No security group changes, nothing exposed publicly.
- **AMI:** Amazon Linux 2023 (`ami-07a5b367e8dc8bd92`)
- **Node.js:** installed via `dnf install -y nodejs npm` — **v18.20.8**, npm 10.8.2.

## Current state

- EC2 instance created, running, SSM-registered (`PingStatus: Online`).
- Node.js + npm installed on the instance.
- **No application code exists yet** — no package.json, no Express server, no
  frontend. This is the very next step.

## Next steps

1. Scaffold the Express app + frontend (drag-drop batch upload UI, format/quality/
   resize controls) — locally first, or directly on the instance via SSM.
2. `npm install libraw-wasm sharp archiver express multer` on the instance.
3. Wire up: upload → libraw-wasm decode → sharp resize/encode → archiver zip →
   download, with batch progress reporting.
4. Get an SSM port-forwarding session working end-to-end so Terrence can hit the
   UI from his browser.
5. Test against real RAW files from his camera to confirm format support and
   demosaic quality.
6. Remember this instance is a throwaway/testing box — don't build deployment
   tooling around it as if it's permanent; the real migration target is still TBD.
