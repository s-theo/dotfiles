#!/bin/bash
# 批量将 txt 规则转换为 mrs（自动识别 domain / ipcidr）
# 兼容 macOS 默认 Bash 3.2
# 依赖：mihomo

read -p "请输入要处理的目录（相对于当前根目录，可留空使用默认目录 Proxy/Rules）: " input_dir
DIR="${input_dir:-Proxy/Rules}"

if [ ! -d "$DIR" ]; then
    echo "❌ 目录不存在：$DIR"
    exit 1
fi

echo "📂 处理目录: $DIR"
echo

shopt -s nullglob
FILES=("$DIR"/*.txt)

if [ ${#FILES[@]} -eq 0 ]; then
    echo "⚠️ 目录中没有 txt 文件"
    exit 0
fi

for FILE in "${FILES[@]}"; do
    NAME="$(basename "$FILE" .txt)"
    OUT="$DIR/$NAME.mrs"

    # 文件名转小写（兼容 Bash 3.2）
    LOWER_NAME="$(echo "$NAME" | tr 'A-Z' 'a-z')"

    # 读取有效行（去空行、去注释）
    VALID_LINES="$(grep -Ev '^\s*($|#)' "$FILE" || true)"

    if [ -z "$VALID_LINES" ]; then
        echo "⏭ 跳过空规则文件: $(basename "$FILE")"
        continue
    fi

    # 默认行为
    BEHAVIOR="domain"

    # ① 文件名优先判断
    if echo "$LOWER_NAME" | grep -Eq '(^|[-_])ip(cidr)?($|[-_])'; then
        BEHAVIOR="ipcidr"
    else
        # ② 内容兜底判断
        if echo "$VALID_LINES" | grep -Eq '([0-9]{1,3}\.){3}[0-9]{1,3}(/([0-9]|[12][0-9]|3[0-2]))?'; then
            BEHAVIOR="ipcidr"
        fi
    fi

    # ③ 内容类型检测（正确版）
    HAS_IP=0
    HAS_DOMAIN=0

    echo "$VALID_LINES" | grep -Eq '([0-9]{1,3}\.){3}[0-9]{1,3}' && HAS_IP=1
    echo "$VALID_LINES" | grep -Eq '[a-zA-Z]' && HAS_DOMAIN=1

    # 混合规则直接拒绝
    if [ $HAS_IP -eq 1 ] && [ $HAS_DOMAIN -eq 1 ]; then
        echo "❌ 检测到混合规则（IP + 域名），请拆分文件: $(basename "$FILE")"
        continue
    fi

    # 文件名标记为 IP，但内容没有 IP
    if echo "$LOWER_NAME" | grep -Eq '(^|[-_])ip(cidr)?($|[-_])' && [ $HAS_IP -eq 0 ]; then
        echo "❌ 文件名标记为 IP，但内容不包含 IP，跳过: $(basename "$FILE")"
        continue
    fi

    echo "🔄 转换: $(basename "$FILE") → $(basename "$OUT")  类型: $BEHAVIOR"

    if mihomo convert-ruleset "$BEHAVIOR" text "$FILE" "$OUT"; then
        echo "✅ 完成: $(basename "$OUT")"
    else
        echo "❌ 转换失败: $(basename "$FILE")"
    fi

    echo
done

echo "🎉 所有规则处理完成"
