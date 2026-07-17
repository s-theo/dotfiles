#!/bin/sh
# OpenClash Mihomo Smart 内核管理工具
# 面向 OpenWrt / BusyBox ash，直接使用 vernesong/mihomo 官方 Alpha Release。

set -u

SCRIPT_VERSION="1.0.0"
OPENCLASH_DIR="${SMARTCORE_OPENCLASH_DIR:-/etc/openclash}"
CORE_DIR="${SMARTCORE_CORE_DIR:-}"
CORE_PATH=""
BACKUP_PATH=""
SERVICE_PATH="${SMARTCORE_SERVICE:-/etc/init.d/openclash}"
RELEASE_TAG="${SMARTCORE_RELEASE_TAG:-Prerelease-Alpha}"
PLATFORM="${SMARTCORE_PLATFORM:-}"
GITHUB_PROXY="${SMARTCORE_GITHUB_PROXY:-}"
RELEASE_REPO="vernesong/mihomo"
RELEASE_BASE_URL="https://github.com/${RELEASE_REPO}/releases/download/${RELEASE_TAG}"
RELEASE_API="https://api.github.com/repos/${RELEASE_REPO}/releases/tags/${RELEASE_TAG}"
VERSION_URL="${RELEASE_BASE_URL}/version.txt"
CHECKSUMS_URL="${RELEASE_BASE_URL}/checksums.txt"
CHANGELOG_API="$RELEASE_API"
CHANGELOG_PAGE="https://github.com/${RELEASE_REPO}/releases/tag/${RELEASE_TAG}"
LOCK_DIR="/tmp/smartcore.lock"
LOCK_HELD=0
TEMP_DIR=""
REMOTE_VERSION=""
ASSET_SHA256=""
LOCAL_VERSION=""
LOCAL_INFO=""
LOCAL_INFO_LOADED=0
HAS_UPDATE="unknown"
MODE="menu"
ASSUME_YES=0
DEBUG=0
INTERACTIVE=0
CPU_FLAGS=""

if [ -t 1 ]; then
    RED="$(printf '\033[0;31m')"
    GREEN="$(printf '\033[0;32m')"
    YELLOW="$(printf '\033[0;33m')"
    BLUE="$(printf '\033[0;34m')"
    RESET="$(printf '\033[0m')"
else
    RED=""
    GREEN=""
    YELLOW=""
    BLUE=""
    RESET=""
fi

log() {
    printf '%s - %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

info() {
    printf '%s%s%s\n' "$BLUE" "$*" "$RESET"
}

success() {
    printf '%s%s%s\n' "$GREEN" "$*" "$RESET"
}

warn() {
    printf '%s%s%s\n' "$YELLOW" "$*" "$RESET" >&2
}

error() {
    printf '%s%s%s\n' "$RED" "$*" "$RESET" >&2
}

debug() {
    if [ "$DEBUG" -eq 1 ]; then
        printf 'DEBUG: %s\n' "$*" >&2
    fi
}

usage() {
    cat <<EOF
Mihomo Smart 内核管理工具 v${SCRIPT_VERSION}

用法: $(basename "$0") [选项]

  -u, --update              检查并更新；需要交互确认
  -a, --auto                自动检查并更新，适合计划任务
  -k, --check               仅检查本地与远程版本
  -c, --changelog           查看 OpenClash Mihomo 更新日志
  -p, --platform PLATFORM   指定平台；linux-amd64 表示按 CPU 自动选择
  -y, --yes                 跳过更新确认
  -d, --debug               输出调试信息
  -h, --help                显示帮助
  无参数                     启动交互菜单

环境变量:
  SMARTCORE_PLATFORM        默认平台
  SMARTCORE_GITHUB_PROXY    GitHub 代理前缀
  SMARTCORE_CORE_DIR        覆盖内核目录（测试/特殊部署）
  SMARTCORE_RELEASE_TAG     Mihomo Release tag，默认 Prerelease-Alpha
EOF
}

cleanup() {
    if [ -n "$TEMP_DIR" ]; then
        case "$TEMP_DIR" in
            /tmp/smartcore.*) rm -rf "$TEMP_DIR" ;;
        esac
    fi

    release_lock
}

trap cleanup 0
trap 'exit 130' HUP INT TERM

clear_screen() {
    if [ -t 1 ]; then
        clear
    fi
}

pause() {
    if [ -t 0 ]; then
        printf '按 Enter 键继续...'
        read -r _pause_value
    fi
}

confirm() {
    _confirm_prompt="$1"

    if [ "$ASSUME_YES" -eq 1 ]; then
        return 0
    fi
    if [ ! -t 0 ]; then
        error "当前不是交互式终端；请添加 --yes，或使用 --auto。"
        return 1
    fi

    printf '%s [y/N]: ' "$_confirm_prompt"
    read -r _confirm_answer
    case "$_confirm_answer" in
        y|Y|yes|YES) return 0 ;;
        *) warn "已取消。"; return 1 ;;
    esac
}

require_commands() {
    _missing_commands=""
    for _command in "$@"; do
        if ! command -v "$_command" >/dev/null 2>&1; then
            _missing_commands="${_missing_commands} ${_command}"
        fi
    done

    if [ -n "$_missing_commands" ]; then
        error "缺少必要命令:${_missing_commands}"
        return 1
    fi
}

init_temp() {
    if [ -n "$TEMP_DIR" ]; then
        return 0
    fi

    umask 077
    TEMP_DIR="$(mktemp -d /tmp/smartcore.XXXXXX)" || {
        error "无法创建临时目录。"
        return 1
    }
}

acquire_lock() {
    if mkdir -m 700 "$LOCK_DIR" 2>/dev/null; then
        LOCK_HELD=1
        printf '%s\n' "$$" > "$LOCK_DIR/pid"
        return 0
    fi

    if [ -r "$LOCK_DIR/pid" ]; then
        _lock_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
        error "已有 Smart 内核任务运行中（PID: ${_lock_pid:-unknown}）。"
    else
        error "无法获取更新锁：$LOCK_DIR"
    fi
    return 1
}

release_lock() {
    if [ "$LOCK_HELD" -eq 1 ]; then
        rm -f "$LOCK_DIR/pid"
        rmdir "$LOCK_DIR" 2>/dev/null || true
        LOCK_HELD=0
    fi
}

require_root() {
    if [ "$(id -u)" -ne 0 ]; then
        error "更新必须以 root 身份运行。"
        return 1
    fi
}

resolve_core_dir() {
    if [ -z "$CORE_DIR" ]; then
        _small_flash="0"
        if command -v uci >/dev/null 2>&1; then
            _small_flash="$(uci -q get openclash.config.small_flash_memory 2>/dev/null || true)"
        fi

        if [ "$_small_flash" = "1" ]; then
            CORE_DIR="/tmp/etc/openclash/core"
        else
            CORE_DIR="${OPENCLASH_DIR}/core"
        fi
    fi

    CORE_PATH="${CORE_DIR}/clash_meta"
    BACKUP_PATH="${CORE_DIR}/clash_meta.bak"
    debug "CORE_DIR=$CORE_DIR"
}

require_openclash() {
    if [ ! -x "$SERVICE_PATH" ]; then
        error "未找到 OpenClash 服务：$SERVICE_PATH"
        return 1
    fi
}

with_github_proxy() {
    printf '%s%s\n' "$GITHUB_PROXY" "$1"
}

download_file() {
    _download_url="$1"
    _download_target="$2"
    _download_timeout="${3:-300}"
    _show_progress="${4:-0}"
    _download_url="$(with_github_proxy "$_download_url")"

    debug "下载: $_download_url"
    if [ "$_show_progress" -eq 1 ] && [ "$INTERACTIVE" -eq 1 ] && [ -t 1 ]; then
        curl -fL --progress-bar --retry 3 --retry-delay 2 \
            --connect-timeout 15 --max-time "$_download_timeout" \
            -o "$_download_target" "$_download_url"
    else
        curl -fsSL --retry 3 --retry-delay 2 \
            --connect-timeout 15 --max-time "$_download_timeout" \
            -o "$_download_target" "$_download_url"
    fi
}

configured_platform() {
    if command -v uci >/dev/null 2>&1; then
        _uci_platform="$(uci -q get openclash.config.core_version 2>/dev/null || true)"
        case "$_uci_platform" in
            ""|0) ;;
            *) printf '%s\n' "$_uci_platform"; return 0 ;;
        esac
    fi
    return 1
}

load_cpu_flags() {
    if [ -n "$CPU_FLAGS" ]; then
        return 0
    fi
    if [ ! -r /proc/cpuinfo ]; then
        return 1
    fi

    CPU_FLAGS="$(
        awk -F: '
            /^[[:space:]]*(flags|Features)[[:space:]]*:/ {
                gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2)
                print " " $2 " "
                exit
            }
        ' /proc/cpuinfo
    )"
    [ -n "$CPU_FLAGS" ]
}

cpu_has_flag() {
    load_cpu_flags || return 1
    case "$CPU_FLAGS" in
        *" $1 "*) return 0 ;;
        *) return 1 ;;
    esac
}

supports_amd64_v2() {
    for _required_flag in cx16 lahf_lm popcnt pni sse4_1 sse4_2 ssse3; do
        cpu_has_flag "$_required_flag" || return 1
    done
}

supports_amd64_v3() {
    supports_amd64_v2 || return 1
    for _required_flag in avx avx2 bmi1 bmi2 f16c fma movbe xsave; do
        cpu_has_flag "$_required_flag" || return 1
    done
    cpu_has_flag abm || cpu_has_flag lzcnt
}

recommended_amd64_platform() {
    if supports_amd64_v3; then
        printf '%s\n' "linux-amd64-v3"
    elif supports_amd64_v2; then
        printf '%s\n' "linux-amd64-v2"
    else
        printf '%s\n' "linux-amd64-compatible"
    fi
}

normalize_amd64_platform() {
    case "$PLATFORM" in
        linux-amd64)
            _recommended_platform="$(recommended_amd64_platform)"
            warn "linux-amd64 将按 CPU 自动选择，当前使用：$_recommended_platform"
            PLATFORM="$_recommended_platform"
            ;;
        linux-amd64-v3)
            if ! supports_amd64_v3; then
                _recommended_platform="$(recommended_amd64_platform)"
                warn "当前 CPU 不支持 AMD64 v3，已自动改用：$_recommended_platform"
                PLATFORM="$_recommended_platform"
            fi
            ;;
        linux-amd64-v2)
            if ! supports_amd64_v2; then
                warn "当前 CPU 不支持 AMD64 v2，已自动改用：linux-amd64-compatible"
                PLATFORM="linux-amd64-compatible"
            fi
            ;;
    esac
}

choose_amd64_platform() {
    _default_platform="$(recommended_amd64_platform)"

    if [ "$INTERACTIVE" -ne 1 ]; then
        PLATFORM="$_default_platform"
        return 0
    fi

    printf '\n检测到 x86_64，请选择 OpenClash Smart 内核平台:\n'
    printf '%s\n' \
        "1. $_default_platform（自动推荐，默认）" \
        "2. linux-amd64-compatible（兼容性优先）" \
        "3. linux-amd64-v1" \
        "4. linux-amd64-v2" \
        "5. linux-amd64-v3"
    printf '请选择 [1-5]（默认 1）: '
    read -r _amd64_choice
    case "$_amd64_choice" in
        2) PLATFORM="linux-amd64-compatible" ;;
        3) PLATFORM="linux-amd64-v1" ;;
        4) PLATFORM="linux-amd64-v2" ;;
        5) PLATFORM="linux-amd64-v3" ;;
        *) PLATFORM="$_default_platform" ;;
    esac

    normalize_amd64_platform
}

detect_platform() {
    if [ -n "$PLATFORM" ]; then
        case "$PLATFORM" in
            linux-*) ;;
            *)
                error "平台名称必须以 linux- 开头：$PLATFORM"
                return 1
                ;;
        esac
        normalize_amd64_platform || return 1
        info "使用指定平台：$PLATFORM"
        return 0
    fi

    _configured_platform="$(configured_platform 2>/dev/null || true)"
    if [ -n "$_configured_platform" ]; then
        PLATFORM="$_configured_platform"
        normalize_amd64_platform || return 1
        info "使用 OpenClash 已配置平台：$PLATFORM"
        return 0
    fi

    _machine="$(uname -m)"
    case "$_machine" in
        x86_64|amd64) choose_amd64_platform || return 1 ;;
        i386|i486|i586|i686|x86) PLATFORM="linux-386" ;;
        aarch64|arm64) PLATFORM="linux-arm64" ;;
        armv7l|armv7) PLATFORM="linux-armv7" ;;
        armv6l|armv6) PLATFORM="linux-armv6" ;;
        armv5l|armv5) PLATFORM="linux-armv5" ;;
        mips) PLATFORM="linux-mips-softfloat" ;;
        mipsel) PLATFORM="linux-mipsle-softfloat" ;;
        mips64) PLATFORM="linux-mips64" ;;
        mips64el|mips64le) PLATFORM="linux-mips64le" ;;
        riscv64) PLATFORM="linux-riscv64" ;;
        s390x) PLATFORM="linux-s390x" ;;
        loongarch64)
            error "LoongArch 需要明确 ABI，请使用 --platform linux-loong64-abi1 或 abi2。"
            return 1
            ;;
        *)
            error "不支持的系统架构：$_machine；请使用 --platform 显式指定。"
            return 1
            ;;
    esac

    info "自动检测平台：$PLATFORM"
}

get_local_version() {
    if [ "$LOCAL_INFO_LOADED" -eq 1 ]; then
        return 0
    fi

    LOCAL_VERSION=""
    LOCAL_INFO=""
    if [ -x "$CORE_PATH" ]; then
        LOCAL_INFO="$("$CORE_PATH" -v 2>/dev/null | sed -n '1p')"
        LOCAL_VERSION="$(printf '%s\n' "$LOCAL_INFO" | awk 'NR == 1 { print $3; exit }')"
    fi
    LOCAL_INFO_LOADED=1
}

show_current_info() {
    get_local_version
    if [ -x "$CORE_PATH" ]; then
        printf '当前内核: %s\n' "${LOCAL_INFO:-无法读取版本}"
        printf '内核路径: %s\n' "$CORE_PATH"
    elif [ -f "$CORE_PATH" ]; then
        printf '当前内核: 已安装但不可执行\n'
        printf '内核路径: %s\n' "$CORE_PATH"
    else
        printf '当前内核: 未安装\n'
        printf '目标路径: %s\n' "$CORE_PATH"
    fi
}

fetch_remote_version() {
    init_temp || return 1
    _version_file="${TEMP_DIR}/version.txt"

    info "正在获取 Mihomo Smart 远程版本..."
    if ! download_file "$VERSION_URL" "$_version_file" 30; then
        error "无法获取 Mihomo Release version.txt。"
        return 1
    fi

    REMOTE_VERSION="$(awk 'NF { print $1; exit }' "$_version_file")"
    case "$REMOTE_VERSION" in
        alpha-smart-*) ;;
        *)
            error "远程 Smart 版本格式异常：${REMOTE_VERSION:-empty}"
            return 1
            ;;
    esac
}

check_update() {
    get_local_version
    fetch_remote_version || return 2

    printf '本地版本: %s\n' "${LOCAL_VERSION:-未安装或未知}"
    printf '远程版本: %s\n' "$REMOTE_VERSION"
    printf '平台: %s\n' "$PLATFORM"

    if [ -z "$LOCAL_VERSION" ] || [ "$LOCAL_VERSION" != "$REMOTE_VERSION" ]; then
        HAS_UPDATE="true"
        return 0
    fi

    HAS_UPDATE="false"
    return 1
}

core_asset_name() {
    printf 'mihomo-%s-%s.gz\n' "$PLATFORM" "$REMOTE_VERSION"
}

core_asset_url() {
    printf '%s/%s\n' "$RELEASE_BASE_URL" "$1"
}

fetch_asset_checksum() {
    _asset_name="$1"
    _checksum_file="${TEMP_DIR}/checksums.txt"

    info "正在获取官方 SHA-256 校验文件..."
    if ! download_file "$CHECKSUMS_URL" "$_checksum_file" 30; then
        error "无法获取 Mihomo Release checksums.txt。"
        return 1
    fi

    _expected_asset="./${_asset_name}"
    ASSET_SHA256="$(
        awk -v asset="$_expected_asset" '$2 == asset { print $1; exit }' "$_checksum_file"
    )"
    if [ "${#ASSET_SHA256}" -ne 64 ]; then
        error "checksums.txt 中没有找到有效校验值：$_asset_name"
        return 1
    fi
    case "$ASSET_SHA256" in
        *[!0-9A-Fa-f]*)
            error "checksums.txt 中的 SHA-256 格式异常：$_asset_name"
            return 1
            ;;
    esac
}

verify_asset_checksum() {
    _asset_path="$1"
    _expected_sha256="$2"
    _actual_sha256="$(sha256sum "$_asset_path" | awk '{ print $1; exit }')"

    if [ "$_actual_sha256" != "$_expected_sha256" ]; then
        error "内核 SHA-256 校验失败。"
        error "期望: $_expected_sha256"
        error "实际: ${_actual_sha256:-unknown}"
        return 1
    fi
    success "内核 SHA-256 校验通过。"
}

validate_downloaded_core() {
    _candidate="$1"

    if [ ! -s "$_candidate" ]; then
        error "解压后的内核为空。"
        return 1
    fi

    chmod 755 "$_candidate" || return 1
    _candidate_output="$("$_candidate" -v 2>&1)"
    _candidate_status=$?
    _candidate_full="$(printf '%s\n' "$_candidate_output" | sed -n '1p')"

    if [ "$_candidate_status" -ne 0 ]; then
        error "下载的内核无法在当前设备运行（平台: $PLATFORM，退出码: $_candidate_status）。"
        if [ -n "$_candidate_full" ]; then
            error "内核输出: $_candidate_full"
        fi
        case "$_candidate_output" in
            *"v3 microarchitecture support"*)
                error "当前 CPU 不支持该 v3 产物，请改用 linux-amd64-v2 或 compatible。"
                ;;
        esac
        return 1
    fi

    _candidate_version="$(printf '%s\n' "$_candidate_output" | awk 'NR == 1 { print $3; exit }')"

    case "$_candidate_full" in
        *[Ss]mart*) ;;
        *)
            error "下载的内核不是 Smart 版本：${_candidate_full:-unknown}"
            return 1
            ;;
    esac

    if [ "$_candidate_version" != "$REMOTE_VERSION" ]; then
        error "内核版本不匹配：期望 $REMOTE_VERSION，实际 ${_candidate_version:-unknown}"
        return 1
    fi

    debug "新内核: $_candidate_full"
}

restart_openclash() {
    "$SERVICE_PATH" restart
}

restore_previous_core() {
    _had_previous="$1"

    if [ "$_had_previous" -eq 1 ]; then
        if [ ! -f "$BACKUP_PATH" ]; then
            error "找不到更新前的临时备份：$BACKUP_PATH"
            return 1
        fi
        _restore_stage="${CORE_DIR}/.clash_meta.restore.$$"
        cp -p "$BACKUP_PATH" "$_restore_stage" &&
            chmod 4755 "$_restore_stage" &&
            mv -f "$_restore_stage" "$CORE_PATH" || {
                rm -f "$_restore_stage"
                error "自动恢复原内核失败，请手动恢复：$BACKUP_PATH"
                return 1
            }
        rm -f "$BACKUP_PATH" || warn "原内核已恢复，但临时备份删除失败：$BACKUP_PATH"
    else
        rm -f "$CORE_PATH"
    fi
}

rollback_failed_update() {
    _had_previous="$1"
    _failure_reason="$2"

    warn "$_failure_reason，正在自动恢复..."
    if ! restore_previous_core "$_had_previous"; then
        return 1
    fi

    if [ "$_had_previous" -eq 1 ]; then
        if restart_openclash >/dev/null 2>&1; then
            error "更新失败，原内核已恢复并重新启动 OpenClash。"
        else
            error "原内核已恢复，但 OpenClash 重新启动仍然失败，请检查服务日志。"
        fi
    else
        LOCAL_VERSION=""
        LOCAL_INFO=""
        LOCAL_INFO_LOADED=1
        error "更新前没有旧内核，已移除未成功安装的新内核。"
    fi
    return 1
}

install_downloaded_core() {
    _candidate="$1"
    _install_stage="${CORE_DIR}/.clash_meta.new.$$"
    _backup_stage="${CORE_DIR}/.clash_meta.bak.$$"
    _had_previous=0

    mkdir -p "$CORE_DIR" || return 1
    if [ -f "$CORE_PATH" ]; then
        _had_previous=1
        cp -p "$CORE_PATH" "$_backup_stage" &&
            chmod 4755 "$_backup_stage" &&
            mv -f "$_backup_stage" "$BACKUP_PATH" || {
                rm -f "$_backup_stage"
                error "备份当前内核失败。"
                return 1
            }
    fi

    cp "$_candidate" "$_install_stage" &&
        chmod 4755 "$_install_stage" &&
        mv -f "$_install_stage" "$CORE_PATH" || {
            rm -f "$_install_stage"
            error "原子安装新内核失败。"
            rollback_failed_update "$_had_previous" "新内核安装失败"
            return 1
        }

    if ! restart_openclash; then
        rollback_failed_update "$_had_previous" "OpenClash 重启失败"
        return 1
    fi

    if [ -f "$BACKUP_PATH" ]; then
        rm -f "$BACKUP_PATH" || warn "更新成功，但临时备份删除失败：$BACKUP_PATH"
    fi
    LOCAL_VERSION="$_candidate_version"
    LOCAL_INFO="$_candidate_full"
    LOCAL_INFO_LOADED=1
    success "Smart 内核更新成功：$REMOTE_VERSION"
}

perform_update_locked() {
    check_update
    _check_status=$?
    case "$_check_status" in
        1)
            success "当前已是最新 Smart 内核。"
            return 0
            ;;
        2)
            return 1
            ;;
    esac

    confirm "发现新版本 $REMOTE_VERSION，是否更新？" || return 0
    _asset_name="$(core_asset_name)"
    _archive="${TEMP_DIR}/${_asset_name}"
    _candidate="${TEMP_DIR}/clash"
    _asset_url="$(core_asset_url "$_asset_name")"

    info "正在下载 Smart 内核..."
    download_file "$_asset_url" "$_archive" 300 1 || {
        error "内核下载失败：$_asset_url"
        return 1
    }
    fetch_asset_checksum "$_asset_name" || return 1
    verify_asset_checksum "$_archive" "$ASSET_SHA256" || return 1
    gzip -t "$_archive" || {
        error "下载文件未通过 gzip 完整性校验。"
        return 1
    }
    gzip -dc "$_archive" > "$_candidate" || {
        rm -f "$_candidate"
        error "内核 gzip 解压失败。"
        return 1
    }
    validate_downloaded_core "$_candidate" || return 1
    install_downloaded_core "$_candidate"
}

perform_update() {
    require_root || return 1
    require_openclash || return 1
    require_commands curl gzip sha256sum awk sed uname mktemp mv cp chmod mkdir rm date id || return 1
    detect_platform || return 1
    acquire_lock || return 1

    perform_update_locked
    _update_status=$?
    release_lock
    return "$_update_status"
}

perform_check() {
    require_commands curl awk sed uname mktemp date || return 1
    detect_platform || return 1

    check_update
    _check_status=$?
    case "$_check_status" in
        0) warn "发现新版本：$REMOTE_VERSION" ;;
        1) success "当前已是最新 Smart 内核。" ;;
        2) return 1 ;;
    esac
    return 0
}

show_changelog() {
    require_commands curl mktemp date || return 1
    init_temp || return 1
    _changelog_json="${TEMP_DIR}/changelog.json"

    info "正在获取 Mihomo Smart 更新日志..."
    if command -v jsonfilter >/dev/null 2>&1; then
        if download_file "$CHANGELOG_API" "$_changelog_json" 30; then
            _changelog_body="$(jsonfilter -i "$_changelog_json" -e '@.body' 2>/dev/null || true)"
            if [ -n "$_changelog_body" ]; then
                printf '%s\n' "$_changelog_body"
                return 0
            fi
        fi
    fi

    warn "当前环境无法可靠解析更新日志，请访问："
    printf '%s\n' "$CHANGELOG_PAGE"
}

run_menu_action() {
    _action_title="$1"
    shift

    clear_screen
    printf '%s%s%s\n' "$BLUE" "$_action_title" "$RESET"
    printf '%s\n\n' "==========================================="
    "$@"
    pause
}

show_menu() {
    while true; do
        clear_screen
        printf '%sMihomo Smart 内核管理工具 v%s%s\n' "$BLUE" "$SCRIPT_VERSION" "$RESET"
        printf '%s\n\n' "==========================================="
        show_current_info
        printf '\n%s\n' \
            "1. 检查并更新内核" \
            "2. 仅检查更新" \
            "3. 查看最新更新日志" \
            "0. 退出"
        printf '请选择 [0-3]: '

        if ! read -r _menu_choice; then
            printf '\n'
            return
        fi

        case "$_menu_choice" in
            1) run_menu_action "检查并更新内核" perform_update ;;
            2) run_menu_action "检查内核版本" perform_check ;;
            3) run_menu_action "查看最新更新日志" show_changelog ;;
            0) success "感谢使用！"; return ;;
            *) warn "无效选项。"; pause ;;
        esac
    done
}

parse_args() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            -u|--update) MODE="update" ;;
            -a|--auto) MODE="update"; ASSUME_YES=1 ;;
            -k|--check) MODE="check" ;;
            -c|--changelog) MODE="changelog" ;;
            -p|--platform)
                if [ "$#" -lt 2 ]; then
                    error "--platform 缺少参数。"
                    return 2
                fi
                shift
                PLATFORM="$1"
                ;;
            -y|--yes) ASSUME_YES=1 ;;
            -d|--debug) DEBUG=1 ;;
            -h|--help) MODE="help" ;;
            *)
                error "未知参数：$1"
                return 2
                ;;
        esac
        shift
    done
}

main() {
    parse_args "$@" || {
        usage >&2
        return 2
    }

    if [ "$MODE" = "help" ]; then
        usage
        return 0
    fi

    resolve_core_dir
    init_temp || return 1

    case "$MODE" in
        menu)
            if [ ! -t 0 ]; then
                error "交互菜单需要终端；计划任务请使用 --auto。"
                return 1
            fi
            INTERACTIVE=1
            show_menu
            ;;
        update) perform_update ;;
        check) perform_check ;;
        changelog) show_changelog ;;
    esac
}

main "$@"
