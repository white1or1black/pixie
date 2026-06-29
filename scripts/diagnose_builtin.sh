#!/bin/bash

# Pixie 内置引擎问题诊断脚本
# 用于快速检查内置引擎在 macOS x86 上的异常问题

set -e

echo "========================================"
echo "Pixie 内置引擎诊断工具"
echo "========================================"
echo ""

# 检测操作系统
OS=$(uname -s)
ARCH=$(uname -m)
echo "检测到平台: $OS $ARCH"
echo ""

# 确定日志路径
if [[ "$OS" == "Darwin" ]]; then
    LOG_DIR="$HOME/Library/Application Support/com.pixie.desktop"
    LOG_FILE="$LOG_DIR/pixie.log"
elif [[ "$OS" == "Linux" ]]; then
    LOG_DIR="$HOME/.config/pixie"
    LOG_FILE="$LOG_DIR/pixie.log"
else
    LOG_DIR="$APPDATA\\pixie"
    LOG_FILE="$LOG_DIR\\pixie.log"
fi

echo "日志文件位置: $LOG_FILE"
echo ""

# 检查日志文件是否存在
if [[ ! -f "$LOG_FILE" ]]; then
    echo "❌ 日志文件不存在！"
    echo "   可能原因："
    echo "   1. Pixie 还没有运行过"
    echo "   2. 日志写入权限问题"
    echo "   3. 应用数据目录位置异常"
    echo ""
    echo "正在检查日志目录..."
    if [[ -d "$LOG_DIR" ]]; then
        echo "✅ 日志目录存在: $LOG_DIR"
        echo "   目录内容："
        ls -la "$LOG_DIR"
    else
        echo "❌ 日志目录不存在: $LOG_DIR"
    fi
    exit 1
fi

echo "✅ 日志文件存在"
echo "   文件大小: $(du -h "$LOG_FILE" | cut -f1)"
echo "   最后修改: $(stat -f "%Sm" "$LOG_FILE" 2>/dev/null || stat -c "%y" "$LOG_FILE")"
echo ""

# 统计日志行数
TOTAL_LINES=$(wc -l < "$LOG_FILE")
echo "日志总行数: $TOTAL_LINES"
echo ""

echo "========================================"
echo "🔍 诊断结果"
echo "========================================"
echo ""

# 1. 检查启动日志
echo "1️⃣  启动日志（最后20行）"
echo "-------------------------------------------"
tail -20 "$LOG_FILE"
echo ""

# 2. 检查内置引擎相关日志
echo "2️⃣  内置引擎日志"
echo "-------------------------------------------"
if grep -q "\[builtin\]" "$LOG_FILE"; then
    echo "✅ 找到内置引擎日志"
    echo ""
    echo "最近 20 条 [builtin] 日志："
    grep "\[builtin\]" "$LOG_FILE" | tail -20
else
    echo "⚠️  没有找到内置引擎相关日志"
    echo "   可能内置引擎还没有被使用过"
fi
echo ""

# 3. 检查错误日志
echo "3️⃣  错误日志"
echo "-------------------------------------------"
if grep -qi "error" "$LOG_FILE"; then
    echo "❌ 发现错误日志："
    echo ""
    grep -i "error" "$LOG_FILE" | tail -10
else
    echo "✅ 没有发现错误日志"
fi
echo ""

# 4. 检查 API Key 配置
echo "4️⃣  API Key 配置"
echo "-------------------------------------------"
if grep -q "API key" "$LOG_FILE"; then
    echo "最近 10 条 API Key 相关日志："
    grep "API key" "$LOG_FILE" | tail -10
else
    echo "⚠️  没有找到 API Key 配置日志"
fi
echo ""

# 5. 检查网络/连接问题
echo "5️⃣  网络/连接问题"
echo "-------------------------------------------"
if grep -qi "connection\|tls\|certificate\|network" "$LOG_FILE"; then
    echo "❌ 发现网络相关错误："
    echo ""
    grep -i "connection\|tls\|certificate\|network" "$LOG_FILE" | tail -10
else
    echo "✅ 没有发现明显的网络问题"
fi
echo ""

# 6. 检查平台信息
echo "6️⃣  平台信息"
echo "-------------------------------------------"
if grep -qi "platform\|arch\|target" "$LOG_FILE"; then
    echo "平台相关日志："
    grep -i "platform\|arch\|target" "$LOG_FILE" | tail -5
else
    echo "⚠️  没有找到平台信息日志"
    echo "   建议添加平台检测日志"
fi
echo ""

# 7. 环境变量检查
echo "7️⃣  环境变量"
echo "-------------------------------------------"
if [[ -n "$ANTHROPIC_API_KEY" ]]; then
    echo "✅ ANTHROPIC_API_KEY 已设置（已隐藏）"
    echo "   长度: ${#ANTHROPIC_API_KEY} 字符"
else
    echo "⚠️  ANTHROPIC_API_KEY 未设置"
fi
echo ""

# 8. 网络连接测试
echo "8️⃣  网络连接测试"
echo "-------------------------------------------"
echo "测试连接到 Anthropic API..."
if command -v curl &> /dev/null; then
    if curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 https://api.anthropic.com 2>/dev/null | grep -q "200\|401\|404"; then
        echo "✅ 可以连接到 Anthropic API"
    else
        echo "❌ 无法连接到 Anthropic API"
        echo "   可能的原因："
        echo "   1. 网络连接问题"
        echo "   2. 防火墙阻止"
        echo "   3. 代理设置问题"
    fi
else
    echo "⚠️  curl 命令不可用，跳过网络测试"
fi
echo ""

# 9. Rust 工具链检查
echo "9️⃣  Rust 工具链"
echo "-------------------------------------------"
if command -v rustc &> /dev/null; then
    echo "✅ Rust 已安装"
    rustc --version
    echo ""
    if command -v rustup &> /dev/null; then
        echo "已安装的编译目标："
        rustup target list | grep installed
    fi
else
    echo "⚠️  Rust 未安装"
fi
echo ""

echo "========================================"
echo "📋 诊断建议"
echo "========================================"
echo ""

# 根据诊断结果给出建议
ISSUES_FOUND=0

if ! grep -qi "API key" "$LOG_FILE" && [[ -z "$ANTHROPIC_API_KEY" ]]; then
    echo "❌ 问题：API Key 未配置"
    echo "   解决方案："
    echo "   export ANTHROPIC_API_KEY=\"sk-ant-xxx\""
    echo ""
    ISSUES_FOUND=1
fi

if grep -qi "connection\|tls\|certificate" "$LOG_FILE"; then
    echo "❌ 问题：发现网络/连接错误"
    echo "   解决方案："
    echo "   1. 检查网络连接"
    echo "   2. 检查代理设置"
    echo "   3. 检查系统证书"
    echo ""
    ISSUES_FOUND=1
fi

if [[ "$ARCH" == "x86_64" ]] && [[ "$OS" == "Darwin" ]]; then
    echo "ℹ️  检测到 macOS x86_64 平台"
    echo "   这是报告有问题的平台，请关注日志中的错误"
    echo ""
fi

if [[ $ISSUES_FOUND -eq 0 ]]; then
    echo "✅ 没有发现明显问题"
    echo ""
    echo "如果问题仍然存在，请："
    echo "1. 查看完整的日志文件: cat \"$LOG_FILE\""
    echo "2. 启用 Debug 日志级别"
    echo "3. 联系开发者并提供完整的日志内容"
else
    echo "⚠️  发现了 $ISSUES_FOUND 个可能的问题"
    echo ""
    echo "请按照上述建议解决问题后重新测试"
fi

echo ""
echo "========================================"
echo "🔧 实时日志监控"
echo "========================================"
echo ""
echo "使用以下命令实时监控日志："
echo "tail -f \"$LOG_FILE\""
echo ""

echo "使用以下命令过滤内置引擎日志："
echo "tail -f \"$LOG_FILE\" | grep '\[builtin\]'"
echo ""

echo "完整日志文件："
echo "cat \"$LOG_FILE\""
