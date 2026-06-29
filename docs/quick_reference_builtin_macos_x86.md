# 内置引擎 macOS x86 问题快速参考

## 🚨 问题现象
内置引擎在 macOS x86_64 平台上直接异常返回

## 🔍 立即诊断

### 1. 运行诊断脚本
```bash
cd /path/to/pixie
./scripts/diagnose_builtin.sh
```

### 2. 查看日志
```bash
# 实时监控
tail -f ~/Library/Application\ Support/com.pixie.desktop/pixie.log

# 过滤内置引擎日志
tail -f ~/Library/Application\ Support/com.pixie.desktop/pixie.log | grep '\[builtin\]'
```

## 📋 常见问题和解决方案

| 错误日志 | 原因 | 解决方案 |
|---------|------|---------|
| `no API key found` | API Key 未配置 | `export ANTHROPIC_API_KEY="sk-ant-xxx"` |
| `connection error` | 网络问题 | 检查网络、代理、防火墙 |
| `invalid peer certificate` | TLS 证书问题 | 更新系统证书或切换 TLS 后端 |
| `timeout` | 请求超时 | 检查网络速度或增加超时时间 |

## 🔧 修复步骤

### Step 1: 配置 API Key
```bash
# 方法 1: 环境变量
export ANTHROPIC_API_KEY="sk-ant-your-key-here"

# 方法 2: 在应用设置中配置
# 打开 Pixie -> Settings -> Engine Model Configs
```

### Step 2: 检查网络连接
```bash
# 测试 API 连接
curl -v https://api.anthropic.com

# 检查代理设置
echo $HTTP_PROXY
echo $HTTPS_PROXY
```

### Step 3: 查看详细日志
```bash
# 查看最近的错误
grep -i "error" ~/Library/Application\ Support/com.pixie.desktop/pixie.log | tail -20

# 查看内置引擎的所有日志
grep "\[builtin\]" ~/Library/Application\ Support/com.pixie.desktop/pixie.log
```

### Step 4: 启用 Debug 日志（如果需要）

编辑 `src-tauri/src/lib.rs`，找到：
```rust
.level(log::LevelFilter::Info)
```

改为：
```rust
.level(log::LevelFilter::Debug)
```

重新编译：
```bash
cd src-tauri
cargo build
```

## 🎯 针对 macOS x86 的特别检查

### 1. 确认平台
```bash
uname -m  # 应该输出 x86_64
sw_vers   # 查看 macOS 版本
```

### 2. 检查 Rust 编译目标
```bash
rustup show
# 确认安装了 x86_64-apple-darwin 目标
```

### 3. 检查证书
```bash
# 检查系统证书是否最新
# 系统偏好设置 -> 关于本机 -> 软件更新
```

### 4. 测试 TLS 连接
```bash
# 使用 openssl 测试
openssl s_client -connect api.anthropic.com:443
```

## 📊 诊断报告模板

报告问题时，请包含以下信息：

```markdown
## 环境信息
- 操作系统: macOS [版本]
- 架构: x86_64
- Pixie 版本: 0.8.0-beta.3
- Rust 版本: [版本]

## 问题描述
[描述问题发生的具体情况]

## 相关日志
\`\`\`
[粘贴 grep "\[builtin\]" 的日志输出]
\`\`\`

## 错误信息
\`\`\`
[粘贴具体的错误消息]
\`\`\`

## 已尝试的解决方案
- [ ] 配置了 API Key
- [ ] 检查了网络连接
- [ ] 更新了系统证书
- [ ] 测试了 TLS 连接
```

## 🔗 相关文件

| 文件 | 用途 |
|-----|------|
| `src-tauri/src/engine/builtin/mod.rs` | 内置引擎实现 |
| `src-tauri/src/engine/shared.rs` | 平台相关代码 |
| `src-tauri/src/engine/builtin/platform_detection.rs` | 平台检测工具 |
| `src-tauri/Cargo.toml` | 依赖配置 |
| `scripts/diagnose_builtin.sh` | 诊断脚本 |

## 🆘 获取帮助

1. **查看完整文档**: `docs/builtin_engine_troubleshooting.md`
2. **运行诊断**: `./scripts/diagnose_builtin.sh`
3. **查看日志**: `cat ~/Library/Application\ Support/com.pixie.desktop/pixie.log`
4. **提交 Issue**: 附上完整的诊断报告和日志

## 💡 预防措施

1. **定期检查日志**: 特别是在更新后
2. **保持依赖更新**: `cargo update`
3. **测试网络连接**: 定期验证 API 可访问性
4. **备份配置**: 保存工作配置的 API Key

---

**记住**: 日志是你的朋友！大多数问题都可以从日志中找到线索。
