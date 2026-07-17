#!/bin/sh
# OpenClash Mihomo Smart 内核管理工具
# 面向 OpenWrt / BusyBox ash，使用 OpenClash 官方 core 分支产物。

set -u

SCRIPT_VERSION="1.0.0"
OPENCLASH_DIR="${SMARTCORE_OPENCLASH_DIR:-/etc/openclash}"
CORE_DIR="${SMARTCORE_CORE_DIR:-}"
CORE_PATH=""
BACKUP_PATH=""
SERVICE_PATH="${SMARTCORE_SERVICE:-/etc/init.d/openclash}"
RELEASE_BRANCH="${SMARTCORE_RELEASE_BRANCH:-master}"
PLATFORM="${SMARTCORE_PLATFORM:-}"
GITHUB_PROXY="${SMARTCORE_GITHUB_PROXY:-}"
CORE_REPO="vernesong/OpenClash"
CORE_BRANCH="core"
VERSION_URL="https://raw.githubusercontent.com/${CORE_REPO}/${CORE_BRANCH}/${RELEASE_BRANCH}/core_version"
CHANGELOG_API="https://api.github.com/repos/vernesong/OpenClash/releases/tags/mihomo"
CHANGELOG_PAGE="https://github.com/vernesong/OpenClash/releases/tag/mihomo"
LOCK_DIR="/tmp/smartcore.lock"
LOCK_HELD=0
TEMP_DIR=""
REMOTE_VERSION=""
LOCAL_VERSION=""
HAS_UPDATE="unknown"
MODE="menu"
ASSUME_YES=0
DEBUG=0
INTERACTIVE=0

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
  -r, --rollback            回滚到上一版本
  -c, --changelog           查看 OpenClash Mihomo 更新日志
  -p, --platform PLATFORM   指定 OpenClash 平台，如 linux-amd64-v3
  -y, --yes                 跳过更新/回滚确认
  -d, --debug               输出调试信息
  -h, --help                显示帮助
  无参数                     启动交互菜单

环境变量:
  SMARTCORE_PLATFORM        默认平台
  SMARTCORE_GITHUB_PROXY    GitHub 代理前缀
  SMARTCORE_CORE_DIR        覆盖内核目录（测试/特殊部署）
  SMARTCORE_RELEASE_BRANCH  OpenClash core 发布目录，默认 master
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
    if [ -t 1 ] && [ -n "${TERM:-}" ] && command -v clear >/dev/null 2>&1; then
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
        error "更新和回滚必须以 root 身份运行。"
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
    _download_url="$(with_github_proxy "$_download_url")"

    debug "下载: $_download_url"
    curl -fsSL --retry 3 --retry-delay 2 \
        --connect-timeout 15 --max-time "$_download_timeout" \
        -o "$_download_target" "$_download_url"
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

choose_amd64_platform() {
    _default_platform="linux-amd64"

    if [ "$INTERACTIVE" -ne 1 ]; then
        PLATFORM="$_default_platform"
        return
    fi

    printf '\n检测到 x86_64，请选择 OpenClash Smart 内核平台:\n'
    printf '%s\n' \
        "1. linux-amd64（默认，兼容性优先）" \
        "2. linux-amd64-v3" \
        "3. linux-amd64-v2" \
        "4. linux-amd64-v1" \
        "5. linux-amd64-compatible"
    printf '请选择 [1-5]（默认 1）: '
    read -r _amd64_choice
    case "$_amd64_choice" in
        2) PLATFORM="linux-amd64-v3" ;;
        3) PLATFORM="linux-amd64-v2" ;;
        4) PLATFORM="linux-amd64-v1" ;;
        5) PLATFORM="linux-amd64-compatible" ;;
        *) PLATFORM="$_default_platform" ;;
    esac
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
        info "使用指定平台：$PLATFORM"
        return 0
    fi

    _configured_platform="$(configured_platform 2>/dev/null || true)"
    if [ -n "$_configured_platform" ]; then
        PLATFORM="$_configured_platform"
        info "使用 OpenClash 已配置平台：$PLATFORM"
        return 0
    fi

    _machine="$(uname -m)"
    case "$_machine" in
        x86_64|amd64) choose_amd64_platform ;;
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
    LOCAL_VERSION=""
    if [ -x "$CORE_PATH" ]; then
        LOCAL_VERSION="$("$CORE_PATH" -v 2>/dev/null | awk 'NR == 1 { print $3; exit }')"
    fi
}

show_current_info() {
    get_local_version
    if [ -x "$CORE_PATH" ]; then
        _current_full="$("$CORE_PATH" -v 2>/dev/null | sed -n '1p')"
        printf '当前内核: %s\n' "${_current_full:-无法读取版本}"
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
    _version_file="${TEMP_DIR}/core_version"

    if ! download_file "$VERSION_URL" "$_version_file" 30; then
        error "无法获取 OpenClash core_version。"
        return 1
    fi

    REMOTE_VERSION="$(awk 'NR == 2 { print $1; exit }' "$_version_file")"
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

core_archive_url() {
    printf 'https://raw.githubusercontent.com/%s/%s/%s/smart/clash-%s.tar.gz\n' \
        "$CORE_REPO" "$CORE_BRANCH" "$RELEASE_BRANCH" "$PLATFORM"
}

validate_downloaded_core() {
    _candidate="$1"

    if [ ! -s "$_candidate" ]; then
        error "解压后的内核为空。"
        return 1
    fi

    chmod 755 "$_candidate" || return 1
    _candidate_version="$("$_candidate" -v 2>/dev/null | awk 'NR == 1 { print $3; exit }')"
    _candidate_full="$("$_candidate" -v 2>/dev/null | sed -n '1p')"

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

restore_after_failed_restart() {
    _had_previous="$1"

    warn "OpenClash 重启失败，正在自动恢复原内核..."
    if [ "$_had_previous" -eq 1 ] && [ -f "$BACKUP_PATH" ]; then
        _restore_stage="${CORE_DIR}/.clash_meta.restore.$$"
        cp -p "$BACKUP_PATH" "$_restore_stage" &&
            chmod 4755 "$_restore_stage" &&
            mv -f "$_restore_stage" "$CORE_PATH" || {
                rm -f "$_restore_stage"
                error "自动恢复原内核失败，请手动恢复：$BACKUP_PATH"
                return 1
            }
        restart_openclash >/dev/null 2>&1 || true
        error "更新已回滚，原内核已恢复。"
    else
        rm -f "$CORE_PATH"
        error "更新前没有旧内核，已移除无法启动的新内核。"
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
            return 1
        }

    if ! restart_openclash; then
        restore_after_failed_restart "$_had_previous"
        return 1
    fi

    success "Smart 内核更新成功：$REMOTE_VERSION"
    if [ "$_had_previous" -eq 1 ]; then
        printf '上一版本备份：%s\n' "$BACKUP_PATH"
    fi
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
    _archive="${TEMP_DIR}/clash-${PLATFORM}.tar.gz"
    _candidate="${TEMP_DIR}/clash"
    _archive_url="$(core_archive_url)"

    info "正在下载 Smart 内核..."
    download_file "$_archive_url" "$_archive" 300 || {
        error "内核下载失败：$_archive_url"
        return 1
    }
    gzip -t "$_archive" || {
        error "下载文件未通过 gzip 完整性校验。"
        return 1
    }
    tar -xzf "$_archive" -C "$TEMP_DIR" || {
        error "内核压缩包解压失败。"
        return 1
    }
    validate_downloaded_core "$_candidate" || return 1
    install_downloaded_core "$_candidate"
}

perform_update() {
    require_root || return 1
    require_openclash || return 1
    require_commands curl tar gzip awk sed uname mktemp mv cp chmod mkdir rm date id || return 1
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

perform_rollback_locked() {
    if [ ! -f "$BACKUP_PATH" ]; then
        error "没有找到回滚备份：$BACKUP_PATH"
        return 1
    fi
    confirm "将使用 $BACKUP_PATH 覆盖当前内核，是否继续？" || return 0

    _current_save="${TEMP_DIR}/clash_meta.current"
    _rollback_stage="${CORE_DIR}/.clash_meta.rollback.$$"
    if [ -f "$CORE_PATH" ]; then
        cp -p "$CORE_PATH" "$_current_save" || return 1
    fi

    cp -p "$BACKUP_PATH" "$_rollback_stage" &&
        chmod 4755 "$_rollback_stage" &&
        mv -f "$_rollback_stage" "$CORE_PATH" || {
            rm -f "$_rollback_stage"
            error "恢复备份失败。"
            return 1
        }

    if restart_openclash; then
        success "已回滚到上一版本。"
        return 0
    fi

    error "回滚后的内核无法重启 OpenClash。"
    if [ -f "$_current_save" ]; then
        cp -p "$_current_save" "$_rollback_stage" &&
            chmod 4755 "$_rollback_stage" &&
            mv -f "$_rollback_stage" "$CORE_PATH"
        restart_openclash >/dev/null 2>&1 || true
        warn "已尝试恢复回滚前的内核。"
    fi
    return 1
}

perform_rollback() {
    require_root || return 1
    require_openclash || return 1
    acquire_lock || return 1

    perform_rollback_locked
    _rollback_status=$?
    release_lock
    return "$_rollback_status"
}

show_changelog() {
    require_commands curl mktemp date || return 1
    init_temp || return 1
    _changelog_json="${TEMP_DIR}/changelog.json"

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

show_menu() {
    while true; do
        clear_screen
        printf '%sMihomo Smart 内核管理工具 v%s%s\n' "$BLUE" "$SCRIPT_VERSION" "$RESET"
        printf '%s\n\n' "==========================================="
        show_current_info
        printf '\n%s\n' \
            "1. 检查并更新内核" \
            "2. 仅检查更新" \
            "3. 回滚到上一版本" \
            "4. 查看最新更新日志" \
            "0. 退出"
        printf '请选择 [0-4]: '

        if ! read -r _menu_choice; then
            printf '\n'
            return
        fi

        case "$_menu_choice" in
            1) perform_update; pause ;;
            2) perform_check; pause ;;
            3) perform_rollback; pause ;;
            4) show_changelog; pause ;;
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
            -r|--rollback) MODE="rollback" ;;
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
        rollback) perform_rollback ;;
        changelog) show_changelog ;;
    esac
}

main "$@"
