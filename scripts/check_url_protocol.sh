#!/bin/bash

# URL 协议检查和修复工具
# 用于检查和修复内置引擎的 base_url 配置

set -e

echo "========================================"
echo "Pixie URL 协议检查工具"
echo "========================================"
echo ""

# 确定配置文件位置
OS=$(uname -s)
if [[ "$OS" == "Darwin" ]]; then
    CONFIG_DIR="$HOME/Library/Application Support/com.pixie.desktop"
elif [[ "$OS" == "Linux" ]]; then
    CONFIG_DIR="$HOME/.config/pixie"
else
    CONFIG_DIR="$APPDATA\\pixie"
fi

CONFIG_FILE="$CONFIG_DIR/config.json"
LOG_FILE="$CONFIG_DIR/pixie.log"

echo "配置文件: $CONFIG_FILE"
echo "日志文件: $LOG_FILE"
echo ""

# 检查配置文件是否存在
if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "❌ 配置文件不存在"
    echo "   应用可能还没有运行过"
    exit 1
fi

echo "✅ 配置文件存在"
echo ""

# 提取当前的 base_url 配置
echo "========================================"
echo "🔍 检查当前配置"
echo "========================================"
echo ""

# 使用 jq 提取配置，如果没有 jq 则使用 grep
if command -v jq &> /dev/null; then
    echo "使用 jq 解析配置..."
    echo ""

    # 检查 builtin 配置
    BUILTIN_URL=$(jq -r '.engine_model_configs.builtin.ANTHROPIC_BASE_URL // empty' "$CONFIG_FILE" 2>/dev/null)
    CLAUDE_URL=$(jq -r '.engine_model_configs.claude.ANTHROPIC_BASE_URL // empty' "$CONFIG_FILE" 2>/dev/null)

    if [[ -n "$BUILTIN_URL" ]]; then
        echo "Builtin ANTHROPIC_BASE_URL: $BUILTIN_URL"
        if [[ "$BUILTIN_URL" == http://* ]]; then
            echo "❌ 问题：使用 HTTP 协议（不支持）"
            CORRECT_URL="${BUILTIN_URL/http:/https:}"
            echo "✅ 建议修改为: $CORRECT_URL"
            SUGGESTED_FIX="$CORRECT_URL"
        elif [[ "$BUILTIN_URL" == https://* ]]; then
            echo "✅ 正确：使用 HTTPS 协议"
        else
            echo "⚠️  警告：URL 格式异常"
        fi
        echo ""
    fi

    if [[ -n "$CLAUDE_URL" ]]; then
        echo "Claude ANTHROPIC_BASE_URL: $CLAUDE_URL"
        if [[ "$CLAUDE_URL" == http://* ]]; then
            echo "❌ 问题：使用 HTTP 协议（不支持）"
            CORRECT_URL="${CLAUDE_URL/http:/https:}"
            echo "✅ 建议修改为: $CORRECT_URL"
        elif [[ "$CLAUDE_URL" == https://* ]]; then
            echo "✅ 正确：使用 HTTPS 协议"
        else
            echo "⚠️  警告：URL 格式异常"
        fi
        echo ""
    fi

else
    echo "⚠️  jq 未安装，使用 grep 进行简单检查..."
    echo ""

    if grep -q "http://" "$CONFIG_FILE"; then
        echo "❌ 发现 HTTP 协议配置"
        echo "问题行："
        grep -n "http://" "$CONFIG_FILE" | grep -i "base_url\|anthropic"
        echo ""
        echo "建议手动检查配置文件"
    else
        echo "✅ 未发现明显的 HTTP 协议配置"
    fi
fi

echo ""
echo "========================================"
echo "🔍 检查日志中的 URL"
echo "========================================"
echo ""

if [[ -f "$LOG_FILE" ]]; then
    echo "检查最近的日志中的 base_url..."
    echo ""

    # 提取最近的 base_url 日志
    BASE_URL_LOGS=$(grep "\[builtin\] new session.*base_url=" "$LOG_FILE" 2>/dev/null | tail -5)

    if [[ -n "$BASE_URL_LOGS" ]]; then
        echo "最近使用的 base_url："
        echo "$BASE_URL_LOGS"
        echo ""

        # 检查是否有 HTTP URL
        if echo "$BASE_URL_LOGS" | grep -q "base_url=http://"; then
            echo "❌ 发现 HTTP 协议使用！"
            echo ""
            echo "具体日志："
            grep "\[builtin\] new session.*base_url=http://" "$LOG_FILE" | tail -3
        else
            echo "✅ 日志中的 URL 都是 HTTPS"
        fi
    else
        echo "⚠️  日志中未找到 base_url 信息"
        echo "   内置引擎可能还没有运行过"
    fi
else
    echo "⚠️  日志文件不存在"
fi

echo ""
echo "========================================"
echo "🔧 自动修复"
echo "========================================"
echo ""

if command -v jq &> /dev/null && [[ -n "$BUILTIN_URL" ]] && [[ "$BUILTIN_URL" == http://* ]]; then
    echo "发现可以修复的 HTTP 配置"
    echo ""
    read -p "是否自动修复？(y/N): " -n 1 -r
    echo ""

    if [[ $REPLY =~ ^[Yy]$ ]]; then
        CORRECT_URL="${BUILTIN_URL/http:/https:}"

        echo "正在修复配置..."
        tmp_file=$(mktemp)
        jq ".engine_model_configs.builtin.ANTHROPIC_BASE_URL = \"$CORRECT_URL\"" "$CONFIG_FILE" > "$tmp_file"
        mv "$tmp_file" "$CONFIG_FILE"

        echo "✅ 配置已修复"
        echo "   新 URL: $CORRECT_URL"
        echo ""
        echo "请重启应用使配置生效"
    else
        echo "跳过自动修复"
    fi
elif ! command -v jq &> /dev/null; then
    echo "⚠️  需要安装 jq 才能自动修复"
    echo ""
    echo "安装方法："
    echo "  macOS: brew install jq"
    echo "  Linux: sudo apt-get install jq  # Debian/Ubuntu"
    echo "          sudo yum install jq      # CentOS/RHEL"
else
    echo "✅ 配置正确，无需修复"
fi

echo ""
echo "========================================"
echo "📋 手动修复指南"
echo "========================================"
echo ""

if [[ -n "$BUILTIN_URL" ]] && [[ "$BUILTIN_URL" == http://* ]]; then
    echo "方法 1: 修改配置文件"
    echo "-------------------------------------------"
    echo "编辑文件: $CONFIG_FILE"
    echo "找到 \"ANTHROPIC_BASE_URL\": \"http://..."
    echo "改为: \"ANTHROPIC_BASE_URL\": \"https://..."
    echo ""
fi

echo "方法 2: 设置环境变量"
echo "-------------------------------------------"
echo "在终端中执行："
echo "export ANTHROPIC_BASE_URL=\"https://api.anthropic.com\""
echo ""

echo "方法 3: 应用内配置"
echo "-------------------------------------------"
echo "打开 Pixie -> Settings -> Engine Model Configs"
echo "设置 ANTHROPIC_BASE_URL 为 https://..."
echo ""

echo "========================================"
echo "🧪 验证修复"
echo "========================================"
echo ""

echo "修复后，请验证配置："
echo ""
echo "1. 重启应用"
echo "2. 运行此工具再次检查"
echo "3. 查看日志确认使用 HTTPS："
echo "   tail -f \"$LOG_FILE\" | grep \"\\[builtin\\] new session\""
echo ""

echo "预期日志输出："
echo "[builtin] new session: model=claude-sonnet-4-6, base_url=https://api.anthropic.com, cwd=..."
echo "                                                                      ^^^^^^ 注意这里是 https"
echo ""

echo "========================================"
echo "🔗 相关信息"
echo "========================================"
echo ""
echo "支持的协议："
echo "  ✅ https:// (必须)"
echo "  ❌ http:// (不支持)"
echo ""
echo "默认端点："
echo "  https://api.anthropic.com"
echo ""
echo "文档："
echo "  docs/builtin_engine_protocol_support.md"
echo ""
