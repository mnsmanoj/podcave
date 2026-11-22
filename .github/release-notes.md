## Which file do I download?

Pick the one that matches your computer. You only need one file.

| Your computer | Download |
|---|---|
| **Windows**, almost every laptop and desktop (Intel or AMD processor) | [podcave-{{VERSION}}-windows-amd64.exe](https://github.com/{{REPO}}/releases/download/{{VERSION}}/podcave-{{VERSION}}-windows-amd64.exe) |
| **Windows on ARM** (Snapdragon / Copilot+ PCs, Surface Pro X) | [podcave-{{VERSION}}-windows-arm64.exe](https://github.com/{{REPO}}/releases/download/{{VERSION}}/podcave-{{VERSION}}-windows-arm64.exe) |
| **Mac with Apple chip** (M1, M2, M3, M4 and newer) | [podcave-{{VERSION}}-darwin-arm64](https://github.com/{{REPO}}/releases/download/{{VERSION}}/podcave-{{VERSION}}-darwin-arm64) |
| **Mac with Intel processor** (most Macs from before 2021) | [podcave-{{VERSION}}-darwin-amd64](https://github.com/{{REPO}}/releases/download/{{VERSION}}/podcave-{{VERSION}}-darwin-amd64) |
| **Linux**, regular PCs and servers | [podcave-{{VERSION}}-linux-amd64](https://github.com/{{REPO}}/releases/download/{{VERSION}}/podcave-{{VERSION}}-linux-amd64) |
| **Linux on ARM** (Raspberry Pi 4/5 with 64-bit OS, AWS Graviton, other ARM servers) | [podcave-{{VERSION}}-linux-arm64](https://github.com/{{REPO}}/releases/download/{{VERSION}}/podcave-{{VERSION}}-linux-arm64) |

`amd64` is the name for regular 64-bit Intel and AMD processors (it works on Intel too, despite the name). `arm64` is for ARM processors such as Apple chips, Snapdragon and Raspberry Pi. `darwin` means macOS.

### Not sure which one you have?

- **Windows:** Settings, System, About, then look at *System type*. "x64-based processor" means **amd64**, "ARM-based processor" means **arm64**.
- **Mac:** Apple menu, About This Mac. If it shows *Chip: Apple M1* (or M2, M3 and so on), use **darwin-arm64**. If it shows *Processor: Intel*, use **darwin-amd64**.
- **Linux:** run `uname -m`. `x86_64` means **amd64**, `aarch64` means **arm64**. 32-bit systems (`armv7l`, older Raspberry Pi OS) are not supported.

## How to run it

Nothing to install and no admin rights needed. A console window opens and your browser signs in automatically. Keep the console open while you use Pod Cave.

**Windows**
1. Double-click the `.exe`.
2. If Windows SmartScreen says it protected your PC, click **More info**, then **Run anyway**. This appears because the file is not code-signed yet.

**Mac** (in Terminal)
```sh
cd ~/Downloads
chmod +x podcave-{{VERSION}}-darwin-*
xattr -d com.apple.quarantine podcave-{{VERSION}}-darwin-*
./podcave-{{VERSION}}-darwin-arm64    # or darwin-amd64 on an Intel Mac
```
The `xattr` line stops macOS from blocking an app that is not from the App Store.

**Linux**
```sh
chmod +x podcave-{{VERSION}}-linux-*
./podcave-{{VERSION}}-linux-amd64     # or linux-arm64
```

On Mac and Linux, paste your kubeconfig path (for example `~/.kube/config`) when Pod Cave asks for it.

## Check the download (optional)

`SHA256SUMS` lists the checksum of every file. Every binary also has a signed build attestation that proves it was built by this repository's Release workflow:

```sh
gh attestation verify podcave-{{VERSION}}-windows-amd64.exe --repo {{REPO}}
```

On Windows you can compare checksums with `Get-FileHash .\podcave-{{VERSION}}-windows-amd64.exe -Algorithm SHA256`.
