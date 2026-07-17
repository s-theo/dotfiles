#!/bin/bash
# 批量将 txt 规则转换为 mrs（自动识别 domain / ipcidr）
# 兼容 macOS 默认 Bash 3.2
# 依赖：mihomo

set -u

DEFAULT_DIR="Proxy/Rules"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
CURRENT_TMP=""

usage() {
    printf '用法: %s [规则目录]\n' "$(basename "$0")"
    printf '目录默认为 %s，相对路径按仓库根目录解析。\n' "$DEFAULT_DIR"
}

cleanup() {
    if [ -n "$CURRENT_TMP" ] && [ -e "$CURRENT_TMP" ]; then
        rm -f -- "$CURRENT_TMP"
    fi
}

trap cleanup EXIT
trap 'exit 130' HUP INT TERM

if [ "$#" -gt 1 ]; then
    usage >&2
    exit 2
fi

case "${1:-}" in
    -h|--help)
        usage
        exit 0
        ;;
esac

if ! command -v mihomo >/dev/null 2>&1; then
    printf '❌ 未找到 mihomo，请先安装并确保它位于 PATH 中。\n' >&2
    exit 127
fi

if [ "$#" -eq 1 ]; then
    INPUT_DIR="$1"
elif [ -t 0 ]; then
    read -r -p "请输入要处理的目录（相对于仓库根目录，可留空使用 $DEFAULT_DIR）: " INPUT_DIR
    INPUT_DIR="${INPUT_DIR:-$DEFAULT_DIR}"
else
    INPUT_DIR="$DEFAULT_DIR"
fi

case "$INPUT_DIR" in
    /*) DIR="$INPUT_DIR" ;;
    *) DIR="$REPO_ROOT/$INPUT_DIR" ;;
esac

if [ ! -d "$DIR" ]; then
    printf '❌ 目录不存在：%s\n' "$DIR" >&2
    exit 1
fi

# 输出：有效行数、IP 行数、非 IP 行数。
# IPv4 会校验地址段与 CIDR；IPv6 会校验字符集与 CIDR 范围。
classify_rules() {
    awk '
        function is_uint(value) {
            return value ~ /^[0-9]+$/
        }

        function is_ipv4(value, parts, address, prefix, octets, count, i) {
            count = split(value, parts, "/")
            if (count > 2) {
                return 0
            }

            address = parts[1]
            if (count == 2) {
                prefix = parts[2]
                if (!is_uint(prefix) || prefix < 0 || prefix > 32) {
                    return 0
                }
            }

            if (split(address, octets, ".") != 4) {
                return 0
            }

            for (i = 1; i <= 4; i++) {
                if (!is_uint(octets[i]) || octets[i] < 0 || octets[i] > 255) {
                    return 0
                }
            }

            return 1
        }

        function is_ipv6(value, parts, address, prefix, count) {
            count = split(value, parts, "/")
            if (count > 2) {
                return 0
            }

            address = parts[1]
            if (index(address, ":") == 0 || address !~ /^[0-9A-Fa-f:.]+$/) {
                return 0
            }

            if (count == 2) {
                prefix = parts[2]
                if (!is_uint(prefix) || prefix < 0 || prefix > 128) {
                    return 0
                }
            }

            return 1
        }

        {
            line = $0
            sub(/\r$/, "", line)
            sub(/^[[:space:]]+/, "", line)
            sub(/[[:space:]]+$/, "", line)

            if (line == "" || line ~ /^#/) {
                next
            }

            valid++
            if (is_ipv4(line) || is_ipv6(line)) {
                ip++
            } else {
                non_ip++
            }
        }

        END {
            printf "%d %d %d\n", valid + 0, ip + 0, non_ip + 0
        }
    ' "$1"
}

printf '📂 处理目录: %s\n\n' "$DIR"

shopt -s nullglob
FILES=("$DIR"/*.txt)

if [ "${#FILES[@]}" -eq 0 ]; then
    printf '⚠️ 目录中没有 txt 文件\n'
    exit 0
fi

CONVERTED=0
SKIPPED=0
FAILED=0

for FILE in "${FILES[@]}"; do
    NAME="$(basename "$FILE" .txt)"
    OUT="$DIR/$NAME.mrs"
    LOWER_NAME="$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]')"

    if ! CLASSIFICATION="$(classify_rules "$FILE")"; then
        printf '❌ 无法读取规则文件，跳过: %s\n' "$(basename "$FILE")" >&2
        FAILED=$((FAILED + 1))
        continue
    fi

    read -r VALID_COUNT IP_COUNT NON_IP_COUNT <<EOF
$CLASSIFICATION
EOF

    if [ "$VALID_COUNT" -eq 0 ]; then
        printf '⏭ 跳过空规则文件: %s\n' "$(basename "$FILE")"
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    if [ "$IP_COUNT" -gt 0 ] && [ "$NON_IP_COUNT" -gt 0 ]; then
        printf '❌ 检测到混合规则（IP + 非 IP），请拆分文件: %s\n' "$(basename "$FILE")" >&2
        FAILED=$((FAILED + 1))
        continue
    fi

    BEHAVIOR="domain"
    if printf '%s\n' "$LOWER_NAME" | grep -Eq '(^|[-_])ip(cidr)?($|[-_])'; then
        if [ "$IP_COUNT" -eq 0 ]; then
            printf '❌ 文件名标记为 IP，但内容不包含有效 IP/CIDR，跳过: %s\n' "$(basename "$FILE")" >&2
            FAILED=$((FAILED + 1))
            continue
        fi
        BEHAVIOR="ipcidr"
    elif [ "$IP_COUNT" -gt 0 ]; then
        BEHAVIOR="ipcidr"
    fi

    printf '🔄 转换: %s → %s  类型: %s\n' \
        "$(basename "$FILE")" "$(basename "$OUT")" "$BEHAVIOR"

    if ! CURRENT_TMP="$(mktemp "${OUT}.tmp.XXXXXX")"; then
        FAILED=$((FAILED + 1))
        printf '❌ 无法创建临时输出文件: %s\n' "$(basename "$OUT")" >&2
        continue
    fi

    if mihomo convert-ruleset "$BEHAVIOR" text "$FILE" "$CURRENT_TMP"; then
        if chmod 644 "$CURRENT_TMP" && mv -f -- "$CURRENT_TMP" "$OUT"; then
            CURRENT_TMP=""
            CONVERTED=$((CONVERTED + 1))
            printf '✅ 完成: %s\n' "$(basename "$OUT")"
        else
            rm -f -- "$CURRENT_TMP"
            CURRENT_TMP=""
            FAILED=$((FAILED + 1))
            printf '❌ 无法替换输出文件: %s\n' "$(basename "$OUT")" >&2
        fi
    else
        rm -f -- "$CURRENT_TMP"
        CURRENT_TMP=""
        FAILED=$((FAILED + 1))
        printf '❌ 转换失败: %s\n' "$(basename "$FILE")" >&2
    fi

    printf '\n'
done

printf '📊 转换完成: 成功 %d，跳过 %d，失败 %d\n' "$CONVERTED" "$SKIPPED" "$FAILED"

if [ "$FAILED" -gt 0 ]; then
    exit 1
fi
