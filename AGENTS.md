# AGENTS.md - dotfiles

Applies to the entire repository. There are no nested instruction files.

## Safe startup

1. Work from `/root/workspace/dotfiles` and read this file before editing.
2. Inspect `git status --short --branch`, the current branch/upstream and any in-progress Git operation. Preserve all staged, unstaged and untracked work.
3. `git fetch --prune origin` is safe for refreshing remote refs. Do not stash, reset, clean, rebase or switch branches unless Theo explicitly authorizes it.
4. Do not run `pnpm pull` as a routine startup step. It executes `git fetch origin && git reset --hard origin/main`; use it only when the current branch is `main`, no Git operation is in progress, `git status --porcelain` is empty and Theo explicitly wants local `main` replaced by `origin/main`.
5. If an applicable `AGENTS.md` already has unrelated changes, stop rather than overwrite them.

## Repository map

- `Proxy/Clash/`: Mihomo configuration templates. Preserve YAML anchors, policy/rule ordering, endpoints and credential-like template fields unless the task targets them.
- `Proxy/Rules/`: tracked, generated `.mrs` binaries. Their local `*.txt` inputs are ignored by `.gitignore`.
- `Tools/`: `linux.sh` (Debian/Ubuntu Bash 3.2 system maintenance), `mrs.sh` (Bash 3.2 rule conversion using `mihomo`) and `smartcore.sh` (OpenWrt/BusyBox `ash` Smart-core manager).
- `TeleBox_Custom_Plugins/`: standalone TeleBox TypeScript plugins using host-provided aliases and packages; this repository has no TeleBox build or test harness.
- `zshrc/`, `Brewfile`: Linux/macOS shell and workstation setup.
- `icon/`: binary image assets plus `icon/icon.json`.
- `default.json`: shared Renovate preset; `renovate.json` extends it through `github>s-theo/dotfiles`.
- `.github/workflows/update_time.yml`: the only GitHub Actions workflow; it rewrites pushed `main` commits and is not a validation workflow.

## Toolchain and commands

- Use the `packageManager` version in `package.json` (`pnpm@11.14.0`). There is no Node version file; the current dependency graph requires Node `>=22.22.1`.
- `pnpm-workspace.yaml` intentionally sets `minimumReleaseAge: 0`; do not change this policy without Theo's explicit authorization.
- Install reproducibly: `pnpm install --frozen-lockfile`
- Check supported files: `pnpm run format:check`
- Apply Biome formatting/organize-imports only when intended: `pnpm run format`
- Regenerate rule sets only when intended: `pnpm run mrs`
- Always check patch whitespace: `git diff --check`

Biome formats supported JSON/TypeScript files. It excludes `pnpm-lock.yaml`, Clash YAML, `.mrs` files and images; shell and Markdown are not validated by Biome. The linter is disabled. Do not add Prettier. `lint-staged` is configured but no Git hook invokes it automatically. There is no repository build, unit-test or TypeScript typecheck command.

## Editing constraints

### Proxy

- Do not broadly reformat Clash YAML or manually edit the `# Updated:` timestamp. Validate each changed config with Mihomo in a temporary data directory:

  ```sh
  mihomo -t -d "$(mktemp -d)" -f "$PWD/Proxy/Clash/T-Mihomo.yaml"
  mihomo -t -d "$(mktemp -d)" -f "$PWD/Proxy/Clash/T-Smart.yaml"
  ```

- Never hand-edit `.mrs` binaries. `pnpm run mrs` requires `mihomo`, reads ignored `Proxy/Rules/*.txt` files and rewrites tracked outputs. Run it only for an authorized rules change, then confirm only the intended `.mrs` files changed. If source text is unavailable, report that regeneration is blocked.

### Scripts and plugins

- `Tools/linux.sh` and `Tools/mrs.sh` may use Bash 3.2 features; keep `Tools/smartcore.sh` POSIX/BusyBox `ash` compatible.
- Do not run interactive/update modes of system scripts as tests: they can install packages, alter firewalls/shells or replace and restart the OpenClash core.
- TeleBox imports such as `@utils/*` and `teleproto` are supplied by the host project. Do not invent local dependencies or claim local typechecking coverage.
- Keep asset filenames and `icon/icon.json` URLs aligned. Avoid changing public download URLs or proxy/sponsor endpoints incidentally.

## Validation by change type

- Dependency metadata: `pnpm install --frozen-lockfile`, `pnpm run format:check`, `git diff --check`.
- Biome-covered JSON/TypeScript: `pnpm run format:check`, `git diff --check`.
- Tool shell scripts:

  ```sh
  bash -n Tools/linux.sh Tools/mrs.sh
  sh -n Tools/smartcore.sh
  busybox ash -n Tools/smartcore.sh
  ./Tools/linux.sh --help
  ./Tools/mrs.sh --help
  ./Tools/smartcore.sh --help
  ```

- Zsh configuration: `zsh -n zshrc/*.zshrc`.
- Clash YAML: run the applicable Mihomo command above plus `git diff --check`.
- Rule sources/artifacts: run `pnpm run mrs` only as the intended generation step, then review `git diff --name-only -- Proxy/Rules`.
- Documentation or `AGENTS.md` only: verify commands/paths against the repository and run `git diff --check`; Biome adds no coverage for Markdown.
- Before handoff, run `git status --short --branch` and prove the changed-file set contains no unrelated files.

## Git and delivery

- Commit, push, PR, merge, release and branch operations require Theo's explicit authorization.
- Repository files are statically delivered from `main` by an external Vercel Git integration. Cloudflare provides DNS/CDN proxying, not Pages or Workers hosting; there is no tracked site build or deploy command.
- Every push to `main` triggers `update_time.yml`. It replaces an existing `# Updated:` line in changed non-`.mrs` files under `Proxy/`, amends the tip commit with a Shanghai timestamp and bot author, then force-pushes `main`. Therefore the pushed SHA/message/author are not final.
- After an authorized `main` push, wait for that workflow to finish and verify its result. Run `pnpm pull` only when still on `main`, no Git operation is active and `git status --porcelain` is empty, then confirm local `main` matches the rewritten `origin/main`.
