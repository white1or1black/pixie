---
name: release
description: Publish a new Pixie desktop app version via GitHub Releases and Tauri updater. Use when the user asks to release, publish, ship, bump version, tag app-v*, or run the release CI workflow for this repository.
---

# Pixie Release

Publish a version so installed users can update via **Settings → Check for Updates** (Tauri updater reads `latest.json` from GitHub Releases).

Full reference: [docs/releasing.md](../../../docs/releasing.md)

## Preconditions

Before starting, verify:

1. **Target branch is `main`** and includes everything to ship (merge open PRs first if needed).
2. **New version > latest published** — check with:
   ```bash
   gh release list --limit 1
   ```
3. **Three version fields will match** after bump: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`.
4. **Network + `gh` auth** — commands need GitHub access (`git push`, `gh run watch`, `gh release edit`).
5. **Do not commit secrets** — never stage `~/.tauri/pixie.key` or `.env`.

## Release workflow

Execute these steps in order. Do not skip publishing the draft — CI creates a **draft** Release; users cannot update until it is published.

### 1. Determine version

Pick `X.Y.Z` strictly **greater than** the latest `gh release list` tag (strip `app-v` prefix for the semver in config files).

Example: latest is `app-v0.5.0` → ship `0.5.1` or `0.6.0`.

### 2. Bump version (three files, same semver)

| File | Field |
|------|-------|
| `package.json` | `"version": "X.Y.Z"` |
| `src-tauri/Cargo.toml` | `version = "X.Y.Z"` |
| `src-tauri/tauri.conf.json` | `"version": "X.Y.Z"` |

Only change the package version line in `Cargo.toml`, not dependency versions.

### 3. Commit and push to main

```bash
git checkout main
git pull origin main

git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
git commit -m "$(cat <<'EOF'
release: vX.Y.Z

Brief note on what this release contains.
EOF
)"
git push origin main
```

Use a dedicated `release: vX.Y.Z` commit; do not mix unrelated changes.

### 4. Tag and push (triggers CI)

Tag format **must** be `app-vX.Y.Z` (not `vX.Y.Z`):

```bash
git tag app-vX.Y.Z
git push origin app-vX.Y.Z
```

Workflow: `.github/workflows/release.yml` — builds macOS (arm64 + x86_64), Linux, Windows, signs artifacts, uploads a draft Release with merged `latest.json`.

### 5. Wait for CI

```bash
gh run list --workflow=release.yml --limit 1
gh run watch <run-id>
```

Expect ~15–30 minutes. If failed:

```bash
gh run view <run-id> --log-failed
```

Common failures: missing `TAURI_SIGNING_PRIVATE_KEY` secret, platform-specific build error.

### 6. Publish the draft Release

CI leaves the Release as **draft**. Publish it or users will not see updates:

```bash
gh release edit app-vX.Y.Z --draft=false
```

### 7. Verify

```bash
gh api repos/white1or1black/pixie/releases/latest \
  --jq '{tag: .tag_name, draft: .draft, prerelease: .prerelease}'

gh release download app-vX.Y.Z -p latest.json -O - | head -5
```

Expected: `draft: false`, `tag_name: app-vX.Y.Z`, `latest.json` contains `"version": "X.Y.Z"`.

Report the Release URL to the user: `https://github.com/white1or1black/pixie/releases/tag/app-vX.Y.Z`

## One-shot command block

After manually setting `V=X.Y.Z` and editing the three version files:

```bash
V=0.5.1  # example — set to target version

git checkout main && git pull origin main
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
git commit -m "release: v$V"
git push origin main
git tag "app-v$V" && git push origin "app-v$V"

# After CI succeeds:
gh release edit "app-v$V" --draft=false
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| CI not triggered | Tag must be `app-vX.Y.Z`, not `vX.Y.Z` |
| Users see "up to date" | Version not bumped, or draft not published |
| Check update finds nothing | Wait a few minutes for GitHub CDN; confirm `draft: false` |
| Signature failure in CI | Verify GitHub secret `TAURI_SIGNING_PRIVATE_KEY` matches `~/.tauri/pixie.key` |

## Agent guardrails

- **Never** force-push `main` or delete published tags without explicit user request.
- **Never** publish a version ≤ current latest — updater will ignore it.
- **Never** commit unless the user asked to release (or clearly included release in the task).
- If PRs are not merged, merge or ask before releasing from a stale `main`.
- Prefer `gh` for GitHub operations; use HEREDOC for multi-line commit messages.

## Optional: local updater smoke test

See [docs/releasing.md](../../../docs/releasing.md) §「本地测试更新链路」. Requires `~/.tauri/pixie.key` on the machine running the test build.
