# AGENTS.md - dotfiles

Applies to the entire repository. There are no nested instruction files.

## Safe startup

1. Work from `/root/workspace/dotfiles` and read this file before editing.
2. Inspect `git status --short --branch`, the current branch/upstream and any in-progress Git operation. Preserve all staged, unstaged and untracked work.
3. `git fetch --prune origin` is safe for refreshing remote refs. Do not stash, reset, clean, rebase or switch branches unless Theo explicitly authorizes it.
4. `pnpm pull` executes `git fetch origin && git reset --hard origin/main`. Run it only on `main`, with no Git operation in progress and an empty `git status --porcelain`. If the worktree or index is dirty, stop and preserve the changes before any sync.
5. If an applicable `AGENTS.md` already has unrelated changes, stop rather than overwrite them.

## Repository map

- `Proxy/Clash/`: Mihomo configuration templates. Preserve YAML anchors, policy/rule ordering, endpoints and credential-like template fields unless the task targets them.
- `Proxy/Rules/`: tracked, generated `.mrs` binaries. Their local `*.txt` inputs are ignored by `.gitignore`.
- `Tools/`: `linux.sh` (Debian/Ubuntu system maintenance), `mrs.sh` (rule conversion using `mihomo`) and `smartcore.sh` (OpenWrt/BusyBox `ash` Smart-core manager).
- `TeleBox_Custom_Plugins/`: standalone TeleBox TypeScript plugins using host-provided aliases and packages; this repository has no TeleBox build or test harness.
- `zshrc/`, `Brewfile`: Linux/macOS shell and workstation setup.
- `icon/`: binary image assets plus `icon/icon.json`.
- `default.json`: shared Renovate preset; `renovate.json` extends it through `github>s-theo/dotfiles`.
- `.github/workflows/update_time.yml`: the only GitHub Actions workflow; it rewrites pushed `main` commits and is not a validation workflow.

## Toolchain and commands

- Read the package manager and its exact version from `package.json#packageManager`; read declared dependency and CLI ranges from `package.json`, and exact resolutions plus package-engine constraints from `pnpm-lock.yaml`. There is no separate Node runtime pin.
- Read tool metadata from its owning configuration, such as `biome.json`, instead of recording version snapshots here.
- Treat the dependency release-age policy in `pnpm-workspace.yaml` as intentional; do not change it without Theo's explicit authorization.
- Install reproducibly: `pnpm install --frozen-lockfile`
- Run the canonical formatter, linter and assist check: `pnpm run format:check`
- Apply Biome formatting/organize-imports only when intended: `pnpm run format`
- Regenerate rule sets only when intended: `pnpm run mrs`
- Always check patch whitespace: `git diff --check`

Biome checks supported JSON/TypeScript files with its formatter, recommended linter and organize-imports assist. It excludes `pnpm-lock.yaml`, Clash YAML, `.mrs` files and images; shell and Markdown are not validated by Biome. TypeScript diagnostic-suppression comments are rejected: reproduce the diagnostic and make a minimal type-safe root-cause fix instead of adding another suppression, `any`, double assertions or narrower checks. Do not add Prettier. `lint-staged` is configured but no Git hook invokes it automatically. There is no repository build, unit-test or TypeScript typecheck command.

The VS Code workspace uses Biome only for the tracked TypeScript, JSON and JSONC languages. Keep shell, Zsh, YAML, Markdown and other unsupported files on their existing tools.

## Editing constraints

### Proxy

- Do not broadly reformat Clash YAML or manually edit the `# Updated:` timestamp. Validate each changed config with Mihomo in a temporary data directory:

  ```sh
  mihomo -t -d "$(mktemp -d)" -f "$PWD/Proxy/Clash/T-Mihomo.yaml"
  mihomo -t -d "$(mktemp -d)" -f "$PWD/Proxy/Clash/T-Smart.yaml"
  ```

- Never hand-edit `.mrs` binaries. `pnpm run mrs` requires `mihomo`, reads ignored `Proxy/Rules/*.txt` files and rewrites tracked outputs. Run it only for an authorized rules change, then confirm only the intended `.mrs` files changed. If source text is unavailable, report that regeneration is blocked.

### Scripts and plugins

- Keep `Tools/linux.sh` and `Tools/mrs.sh` compatible with Bash 3.2, the minimum declared in their headers; do not introduce newer Bash features. Keep `Tools/smartcore.sh` POSIX/BusyBox `ash` compatible.
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
- After every commit pushed to `main`, wait for `update_time.yml` to complete its amend/force-push successfully, then run `pnpm pull`. Finish by confirming `git status --porcelain` is empty and `git rev-list --left-right --count HEAD...origin/main` reports `0 0`.
