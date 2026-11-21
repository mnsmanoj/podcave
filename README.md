# 🦇 Pod Cave

A local, single-file Kubernetes "Cave Computer" for AKS (and any other cluster).
Point it at your kubeconfig(s), pick a cluster → namespace → **Pods / Deployments**,
and get live logs with search, `kubectl describe` output, and YAML — in a dark,
bat-themed UI. No install, no admin rights, nothing leaves your machine.

## Download

Grab the binary for your machine from the [Releases](https://github.com/mnsmanoj/podcave/releases) page —
no Go, Node.js or installer needed:

| File | For |
|---|---|
| `podcave-<ver>-windows-amd64.exe` | Most Windows PCs |
| `podcave-<ver>-windows-arm64.exe` | Windows on ARM (e.g. Snapdragon laptops) |
| `podcave-<ver>-darwin-arm64` | Apple Silicon Macs (M1 and newer) |
| `podcave-<ver>-darwin-amd64` | Intel Macs |
| `podcave-<ver>-linux-amd64` / `-linux-arm64` | Linux |

Verify what you downloaded:

```powershell
Get-FileHash .\podcave-v1.0.0-windows-amd64.exe -Algorithm SHA256   # compare with SHA256SUMS
gh attestation verify .\podcave-v1.0.0-windows-amd64.exe --repo mnsmanoj/podcave   # proves it was built by this repo's Release workflow
```

Binaries are not code-signed yet: on Windows choose *More info → Run anyway* (or Properties → Unblock);
on macOS/Linux run `chmod +x podcave-*` and on macOS also `xattr -d com.apple.quarantine podcave-*`.
On macOS/Linux, paste the kubeconfig path (the Browse… dialog is Windows-only) and note that imported
copies are protected by file permissions (0600) rather than DPAPI.

## Run it

```powershell
.\podcave.exe
```

A console window opens and your browser launches signed in. Keep the console open —
it *is* the app. In the console:

| Key | Action |
|---|---|
| `Enter` | Fresh sign-in link (for a new tab or if you closed the browser) |
| `q` + `Enter` / `Ctrl+C` | Quit |

Options: `--port 8899` (fixed port), `--no-browser`, `--data-dir <path>`, `--version`.

## First launch

The **Kubeconfig Vault** opens automatically. Add one or more kubeconfigs:

- **Link a file** (recommended) — e.g. `C:\Users\you\.kube\config`. Read in place every
  time, so `az aks get-credentials` updates show up automatically. Use **Browse…** for
  the native Windows file picker.
- **Import a copy** — upload or paste YAML. Stored encrypted with Windows DPAPI.

Pod Cave remembers your kubeconfigs, last cluster, namespace per cluster, tab, log
settings and drawer width in `%APPDATA%\PodCave\config.json`.

## Features

- Cluster picker across all kubeconfigs (defaults to each file's `current-context`).
- Namespace list; if you can't list namespaces (restricted RBAC), add the ones you use.
- **Pods** tab: live status (CrashLoopBackOff, Init:…, Terminating…), ready, restarts, age,
  node, status filter chips, sorting, search (`/`).
- **Deployments** tab: ready bar, up-to-date/available, images, and the pods behind each one.
- **Logs (Cave Computer)**: live follow, container picker incl. init containers, previous
  container, tail size up to 50k lines, find with highlight / regex / match-case /
  "only matching lines", next/prev match (Enter / Shift+Enter, `Ctrl+F`), timestamps,
  wrap, pause, download. Error/warn lines are colour-coded.
- **Describe** (real `kubectl describe` output incl. events) and **YAML** with find + copy.
- **Utility Belt** (write actions): delete pod, rollout-restart and scale deployments.

## Safety model

| Concern | What Pod Cave does |
|---|---|
| Network exposure | Listens on `127.0.0.1` only. Other machines can't reach it. |
| Other websites / tabs | Requests need a bearer session token held only in that tab (no cookies), Host header must be `127.0.0.1`/`localhost` (blocks DNS rebinding), cross-site and foreign-origin requests are rejected, strict CSP, no framing. |
| Sign-in link | Single-use, expires in 10 minutes, carried in the URL `#fragment` (never sent over HTTP) and removed from the address bar immediately. |
| Credentials | Kubeconfig contents and tokens stay in the backend; never sent to the browser or logged. Imported kubeconfigs are encrypted with DPAPI (your Windows user only). |
| Accidental changes | Always starts in read-only **Night Watch**. Arming the Utility Belt is per session, enforced server-side, and every action requires typing the resource name. You can never do more than your own Kubernetes RBAC allows. |
| Outbound traffic | Only to the API servers in your kubeconfigs. No telemetry, no CDN — all UI assets are embedded in the exe. TLS verification follows your kubeconfig (a red badge warns about `insecure-skip-tls-verify`). |
| Admin rights | None needed. No installer, service, or registry changes. |

## AKS sign-in & "logged out" handling

Pod Cave runs your kubeconfig's `kubelogin` exec plugin itself (like kubectl does):

- Tokens are cached in memory and refreshed **before** they expire; if the API server
  still answers 401, Pod Cave refreshes once and retries automatically.
- When a sign-in is needed, the **Cave Signal** banner appears:
  - device-code logins show the code and a link to `microsoft.com/devicelogin` right in the UI;
  - for `azurecli` mode you get **Re-login (browser)** / **Re-login (device code)** buttons
    (runs `az login` for you, with the tenant from your kubeconfig) plus **Retry**.
- Pod lists and live logs reconnect on their own afterwards. Log streams resume from the
  last timestamp without gaps or duplicate lines.

Tip: convert AKS kubeconfigs once so they reuse your `az login` session:

```powershell
kubelogin convert-kubeconfig -l azurecli
```

## Build from source

Requirements: Go 1.27+ and Node.js 20+ (no admin needed).

```powershell
.\build.ps1          # npm ci + audit, UI build, go vet + tests + govulncheck, podcave.exe + SHA256
```

Layout:

```
main.go                 console, launch link, browser open
internal/server/        loopback HTTP server, security guard, API, NDJSON streams
internal/kube/          kubeconfig contexts, exec/kubelogin auth, watches, logs, describe, actions
internal/store/         %APPDATA%\PodCave settings + DPAPI-encrypted imports
internal/events/        auth/mode events pushed to the UI (Cave Signal)
web/                    React + Vite UI (embedded into the exe)
.github/                CI/CD workflows + Dependabot
```

## CI/CD (GitHub Actions)

| Workflow | Trigger | What it does |
|---|---|---|
| **Ship** (`ship.yml`) | every push & pull request, weekly, or manual | Build + vet + tests on Windows & Linux, then the full Security Scan; on PRs also blocks newly added vulnerable dependencies |
| **Security Scan** (`security-scan.yml`) | manual on **any branch** (Actions → Security Scan → Run workflow), and called by Ship & Release | CodeQL (Go, TypeScript, workflow files), `govulncheck`, Google OSV-Scanner, `npm audit` + npm signature verification |
| **Release** (`release.yml`) | manual: pick a branch, enter a version like `v1.0.0` | **1 Build** (UI + 6 cross-compiled binaries) → **2 Test** (tests + run the binary on Windows, Linux and an Apple Silicon Mac) → **3 Security** (Security Scan + `govulncheck` on every built binary) → **4 Publish** (tag, GitHub Release, `SHA256SUMS`, signed build-provenance attestation) |

Every Action is pinned to a full commit SHA, jobs get least-privilege permissions, and only the Publish job can write.
Dependabot keeps Go, npm and Action versions current. Code-scanning results appear under the repo's
**Security** tab. The Publish job runs in a `release` environment — add required reviewers to it under
*Settings → Environments* if you want a manual approval before anything is published.

The bat logo and artwork are original to this project.
