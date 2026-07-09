# AGENTS.md - dotfiles

## Required Startup

Before making changes in this repository:

1. Enter the project root: `/root/workspace/dotfiles`.
2. Run `pnpm pull` to sync the latest remote changes through the repository script.
3. Read this `AGENTS.md` completely.
4. Inspect the relevant files before editing.

## Project Overview

This repository stores Theo's shared configuration files, proxy rules, scripts, and reusable assets.

Important areas:

- `Proxy/Clash/` stores Mihomo/Clash YAML configuration files.
- `Proxy/Rules/` stores generated `.mrs` rule-set files. Treat them as generated/binary artifacts.
- `TeleBox_Custom_Plugins/` stores custom TypeScript plugins.
- `Tools/` stores shell utilities, including `mrs.sh` for converting text rules to `.mrs`.
- `zshrc/` stores platform-specific zsh configuration files.
- `icon/` stores image assets and `icon.json`.
- `Brewfile`, `default.json`, `renovate.json`, and workflow files are repository-level configuration.
- `Brewfile` installs the Biome VS Code extension; do not reintroduce the Prettier extension unless intentionally reverting formatting tools.

## Commands

Use pnpm:

- Install: `pnpm install --frozen-lockfile`
- Format and apply safe fixes: `pnpm run format`
- Check formatting: `pnpm run format:check`
- Convert rule text files to `.mrs`: `pnpm run mrs`
- Sync with remote: `pnpm pull`

Always use `pnpm pull` instead of plain `git pull` when this repository needs to be synchronized. The `pull` script performs `git fetch origin && git reset --hard origin/main`, so only run it at the required startup point or when the user explicitly asks to resync; do not run it while preserving uncommitted local edits matters.

## Formatting

This repository uses Biome, not Prettier.

- Do not add Prettier or Prettier plugins back.
- Keep `biome.json` as the source of formatting rules.
- Keep `pnpm-lock.yaml`, Clash YAML files, generated `.mrs` files, and image assets out of Biome formatting.
- Use `pnpm run format` before committing broad formatting-sensitive edits.
- Use `pnpm run format:check` during verification.
- `lint-staged` runs `biome check --write --no-errors-on-unmatched`.

## Editing Notes

- Be careful with generated `.mrs` files. Regenerate them via `pnpm run mrs` when source text rules are intentionally changed.
- Avoid reformatting or rewriting proxy YAML files unless the change is intentional and verified.
- Shell scripts may perform system-level changes. Review them carefully and do not run destructive system commands without explicit approval.
- Keep public URLs and sponsored/proxy endpoints intact unless the task explicitly asks to update them.

## Verification

For repository-wide maintenance changes, run:

```bash
pnpm install --frozen-lockfile
pnpm run format:check
git diff --check
```
