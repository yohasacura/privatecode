# Vendored Git Bash

`usr/bin/` here is bash and the coreutils out of Git for Windows' own portable
distribution. It is what the `Bash` tool runs (`core/src/bash.ts`): Claude Code's shell
tool runs under Git Bash on Windows, and PrivateCode ships that shell rather than assuming
the machine has it — the app's whole premise is a machine with nothing installed.

## What this is and where it came from

- **Source:** Git for Windows v2.55.0.windows.5, the official portable release,
  `https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/PortableGit-2.55.0.5-64-bit.7z.exe`
  (a 7-Zip self-extracting archive, 58,960,208 bytes).
- **Archive SHA-256:** `5aa8a20f6e9abb2c755f0e73c91c687701a46b309ad84a0ca6509380fa4ae290` —
  verified BEFORE extraction by `scripts/fetch-vendor.mjs`.
- **Extracted `usr/bin/bash.exe` SHA-256:** `5490d0da5e7cf9d92068cc48fcc590f2bcf8564add8ff91c3b5fe541eb2d72e3`
  (bash 5.3.15(2)-release).
- **Vendored:** 2026-09-03. Smoke-run after staging: every staged `.exe` starts
  (`--version`, no missing-DLL exit), and `bash -c 'echo hi | tee /dev/null | tr a-z A-Z'`
  answers `HI`.
- **Licence:** Git for Windows' `LICENSE.txt` is committed beside this file. bash and the
  coreutils are GPL-3.0, the MSYS2 runtime (`msys-2.0.dll`) LGPL-3.0, the rest of the
  libraries BSD/MIT/LGPL as their own notices say. They are shipped as separate programs
  the app starts as processes, unmodified; the sources are Git for Windows' own
  (`https://github.com/git-for-windows`).

## What is staged, and what is not

A curated subset, not the whole 94 MB `usr/bin`: `bash`, `sh`, and the tools a shell
command reaches for — `ls cat cp mv rm mkdir touch echo printf head tail wc cut tr sort
uniq grep sed awk find xargs which pwd tee date sleep diff du ln chmod stat realpath
sha256sum md5sum cygpath timeout nproc less patch gzip bzip2 unzip tar id whoami hostname
ps kill mktemp expr uname test seq column dos2unix iconv` and the rest of the list in
`scripts/fetch-vendor.mjs` — with every `msys-*.dll` from the same `usr/bin`, so no tool
starts without its library. Left out: perl, ssh, gpg, git itself (`git`, `node`, `python`,
`curl` and `tar` come from the machine's PATH), the editors, and everything under
`mingw64/`.

`etc/fstab` and `etc/nsswitch.conf` come across so the MSYS runtime mounts `/` and finds
`HOME` the way Git Bash does; `tmp/` exists so `/tmp` is a folder inside this tree rather
than a guess.

## Rules

- Verify the publisher's checksum before replacing any of this. An unverified shell in a
  privacy tool is exactly the supply-chain hole the project exists to avoid (see
  `vendor/ripgrep/PROVENANCE.md`, the precedent this file mirrors).
- Update this file whenever the binaries change: version, URL, both hashes, the date.
- `core/scripts/bundle.mjs` stages this whole directory into `core/dist/sidecar/vendor/git`
  when it is present; the Tauri shell hands its path to the sidecar as `PRIVATECODE_BASH`.
