# Pixie 发版指南

本文档说明如何发布 Pixie 新版本,让已安装的用户通过 app 内 **Settings → Check for Updates** 自动更新到最新版。

---

## 工作原理

Pixie 使用 Tauri v2 官方 updater 插件实现应用内自动更新:

1. 用户点击「Check for Updates」时,app 请求 `latest.json`(托管在 GitHub Release)。
2. `latest.json` 里记录最新版本号和各平台下载地址 + 签名。
3. app 拿 `latest.json` 的 `version` 与当前安装版比较:
   - **更高** → 提示有新版本,用户确认后下载、验签、安装、重启。
   - **相同或更低** → 显示「已是最新版本」,不更新。

所以发版的本质就是:**升版本号 + 打 tag 触发 CI 自动构建并发布 Release**,让 `latest.json` 指向新版本。

---

## 前置条件(已就绪,仅首次需要)

- [x] Tauri updater 签名密钥:`~/.tauri/pixie.key`(私钥)+ `tauri.conf.json` 里的 pubkey
- [x] GitHub Secrets:`TAURI_SIGNING_PRIVATE_KEY`(私钥内容)+ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`(空)
- [x] CI workflow:`.github/workflows/release.yml`(打 `app-v*` tag 触发)

---

## 标准发版流程

以从 `0.1.1` 发布 `0.1.2` 为例。

### 1. 升版本号(三处必须一致)

| 文件 | 字段 |
|---|---|
| `package.json` | `"version": "0.1.2"` |
| `src-tauri/Cargo.toml` | `version = "0.1.2"` |
| `src-tauri/tauri.conf.json` | `"version": "0.1.2"` |

> ⚠️ 版本号必须 **大于** 已发布的最新版(当前 `0.1.1`),否则用户的 `check()` 判定为「已是最新」而不更新。

### 2. 提交并推送到 main

```bash
git add -A
git commit -m "feat: 你的变更说明"
git push origin main
```

### 3. 打 tag 并推送(触发 CI)

```bash
git tag app-v0.1.2
git push origin app-v0.1.2
```

> ⚠️ tag 必须是 `app-vX.Y.Z` 格式(匹配 workflow 的 `app-v*` 触发规则)。写成 `v0.1.2` 不会触发 CI。

### 4. 等 CI 完成(约 15–30 分钟)

CI 在 `.github/workflows/release.yml` 会:
- 三平台并行构建(macOS arm64 / x86_64、Linux、Windows)
- 用 `~/.tauri/pixie.key` 签名所有安装包(生成 `.sig`)
- 自动合并 `latest.json`(含全部平台 entry)
- 创建一个 **draft Release**(草稿)

查看进度:https://github.com/white1or1black/pixie/actions,或本地 `gh run watch`。

### 5. 发布 draft Release

CI 跑完发的是**草稿**,必须手动发布,用户才能 check 到(草稿不算 latest):

```bash
gh release edit app-v0.1.2 --draft=false
```

或在网页打开该 Release → 点 **Publish release**。

### ✅ 完成

装着 `0.1.1` 的用户点「Check for Updates」就会发现 `0.1.2` 并更新。

---

## 验证发版成功

```bash
# 确认 release 已发布且是 latest
gh api repos/white1or1black/pixie/releases/latest \
  --jq '{tag: .tag_name, draft: .draft, prerelease: .prerelease}'

# 确认 latest.json 指向目标版本
gh release download app-v0.1.2 -p latest.json -O - | head -3
```

预期:`tag_name` 为 `app-v0.1.2`、`draft: false`、`latest.json` 的 `version` 为 `0.1.2`。

---

## 常见问题排查

| 现象 | 原因 | 解决 |
|---|---|---|
| 推 tag 后 CI 没触发 | tag 格式不对 | 必须是 `app-vX.Y.Z` |
| CI 跑完但用户 check 不到更新 | draft 没发布 | `gh release edit app-vX.Y.Z --draft=false` |
| 用户显示「已是最新」但应有新版 | 版本号没升 / 三处不一致 | 新版本号必须 > 已发布版,且三处一致 |
| 刚发布用户还是 check 不到 | GitHub CDN 传播延迟 | 等几分钟重试 |
| CI 签名步骤失败 | secrets 丢失或密钥不匹配 | 确认 `TAURI_SIGNING_PRIVATE_KEY` 是 `~/.tauri/pixie.key` 的内容 |
| 某平台构建失败 | 平台特定问题 | `gh run view <run-id> --log-failed` 查日志 |

---

## 签名密钥管理

- **私钥**:`~/.tauri/pixie.key`(无密码,已 gitignore,不入库)
- **公钥**:`tauri.conf.json` → `plugins.updater.pubkey`
- **GitHub Secret**:`TAURI_SIGNING_PRIVATE_KEY`(私钥文件内容)

> 🚨 **私钥务必备份**(密码管理器 / 加密离线存储)。一旦丢失,所有已安装的老版本将 **永远无法再更新** —— 新版安装包无法用原密钥签名,`check()` 验签会失败。

### 重新生成密钥(仅当私钥丢失或泄漏)

```bash
pnpm tauri signer generate -w ~/.tauri/pixie.key --ci -f
# 然后更新 tauri.conf.json 的 pubkey(从新的 .pub 文件)
# 并更新 GitHub Secret TAURI_SIGNING_PRIVATE_KEY
# 注意:从这一刻起,所有用旧密钥签发的已安装版本都无法再更新
```

---

## macOS 代码签名说明

当前用 **ad-hoc 签名**(`signingIdentity: "-"`),因为没有 Apple Developer 账号:

- 用户首次打开 `.app` 需 **右键 → 打开**(双击会被 Gatekeeper 拦截,提示「无法打开 / 已损坏」)。
- 更新替换 `.app` 后,可能再次提示 Gatekeeper。

### 升级到正式签名(将来有 Apple Developer 账号后)

1. 在 GitHub 加 secrets:`APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`
2. 删除 `tauri.conf.json` 里 `bundle.macOS.signingIdentity: "-"`
3. updater 配置 **完全不用改**

---

## 本地测试更新链路(可选,不发版)

验证「检查更新 → 下载 → 安装」是否正常工作:

```bash
# 1. 临时把 tauri.conf.json 的 version 改成低于已发布的值(如 "0.1.0")
# 2. 用私钥本地打包
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/pixie.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
pnpm tauri build

# 3. 运行打包出的旧版本 app → Settings → Check for Updates
#    应发现已发布的更高版本并完成更新
# 4. 测完把 tauri.conf.json 的 version 改回
```

---

## 附:一键发版命令序列

```bash
V=0.1.2                                              # 改成你要发的版本
# 手动改三处版本号(或用脚本),然后:
git add -A && git commit -m "release: v$V" && git push origin main
git tag "app-v$V" && git push origin "app-v$V"
# 等 CI 跑完后:
gh release edit "app-v$V" --draft=false
```
