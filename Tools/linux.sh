#!/bin/bash
# Debian / Ubuntu 交互式系统维护工具
# 兼容 Bash 3.2；除 --check 外的操作可能修改系统，请按提示确认。

set -u
set -o pipefail

if [ -t 1 ]; then
    BLUE=$'\033[1;34m'
    GREEN=$'\033[1;32m'
    YELLOW=$'\033[1;33m'
    RED=$'\033[1;31m'
    RESET=$'\033[0m'
else
    BLUE=""
    GREEN=""
    YELLOW=""
    RED=""
    RESET=""
fi

SUDO=()
OS_NAME=""

info() {
    printf '\n%s%s%s\n' "$BLUE" "$*" "$RESET"
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

pause() {
    if [ -t 0 ]; then
        read -r -p "按 Enter 键继续..." _
    fi
}

clear_screen() {
    if [ -t 1 ] && [ -n "${TERM:-}" ] && command -v clear >/dev/null 2>&1; then
        clear
    fi
}

usage() {
    printf '用法: %s [--check|--help]\n' "$(basename "$0")"
    printf '  无参数    启动交互式系统维护菜单\n'
    printf '  --check   仅检查运行环境，不修改系统\n'
    printf '  --help    显示帮助\n'
}

confirm() {
    local prompt="$1"
    local answer

    if [ ! -t 0 ]; then
        error "❌ 当前不是交互式终端，已取消操作。"
        return 1
    fi

    read -r -p "$prompt [y/N]: " answer
    case "$answer" in
        y|Y|yes|YES) return 0 ;;
        *) warn "已取消。"; return 1 ;;
    esac
}

confirm_phrase() {
    local prompt="$1"
    local expected="$2"
    local answer

    if [ ! -t 0 ]; then
        error "❌ 当前不是交互式终端，已取消高风险操作。"
        return 1
    fi

    warn "$prompt"
    read -r -p "请输入 “$expected” 继续: " answer
    if [ "$answer" != "$expected" ]; then
        warn "确认短语不匹配，已取消。"
        return 1
    fi
}

detect_system() {
    if [ ! -r /etc/os-release ]; then
        error "❌ 无法识别系统：缺少 /etc/os-release。"
        return 1
    fi

    # shellcheck disable=SC1091
    . /etc/os-release
    OS_NAME="${PRETTY_NAME:-${NAME:-unknown}}"

    case " ${ID:-} ${ID_LIKE:-} " in
        *debian*|*ubuntu*) ;;
        *)
            error "❌ 仅支持 Debian/Ubuntu 系统，当前为：$OS_NAME"
            return 1
            ;;
    esac

    if ! command -v apt-get >/dev/null 2>&1; then
        error "❌ 未找到 apt-get。"
        return 1
    fi
}

setup_privileges() {
    if [ "$(id -u)" -eq 0 ]; then
        SUDO=()
    elif command -v sudo >/dev/null 2>&1; then
        SUDO=(sudo)
    else
        error "❌ 当前不是 root，且系统未安装 sudo。"
        error "请先切换到 root 安装 sudo，再重新运行此脚本。"
        return 1
    fi
}

preflight() {
    detect_system && setup_privileges
}

run_root() {
    "${SUDO[@]}" "$@"
}

apt_get() {
    run_root env DEBIAN_FRONTEND=noninteractive apt-get "$@"
}

install_packages() {
    if apt_get install -y "$@"; then
        success "✅ 软件安装完成。"
    else
        error "❌ 软件安装失败，请检查上方 apt 输出。"
        return 1
    fi
}

remove_installed_packages() {
    local package
    local installed=()

    for package in "$@"; do
        if dpkg-query -W -f='${db:Status-Abbrev}' "$package" 2>/dev/null | grep -q '^ii'; then
            installed[${#installed[@]}]="$package"
        fi
    done

    if [ "${#installed[@]}" -eq 0 ]; then
        warn "没有找到需要卸载的已安装软件。"
        return 0
    fi

    apt_get purge -y "${installed[@]}"
}

update_system() {
    info "正在更新系统..."
    if apt_get update && apt_get upgrade -y; then
        success "✅ 系统更新完成。"
    else
        error "❌ 系统更新失败，请检查上方 apt 输出。"
        return 1
    fi
}

install_nano() {
    info "正在安装 nano..."
    install_packages nano
}

install_htop() {
    info "正在安装 htop..."
    install_packages htop
}

install_sudo() {
    info "正在安装 sudo..."
    install_packages sudo
}

install_curl() {
    info "正在安装 curl..."
    install_packages curl
}

install_docker() {
    info "正在安装 Docker..."
    install_packages docker.io
}

install_lrzsz() {
    info "正在安装 lrzsz..."
    install_packages lrzsz
}

install_openssh() {
    info "正在安装 OpenSSH..."
    install_packages openssh-server
}

install_git() {
    info "正在安装 Git..."
    install_packages git
}

install_all_common_software() {
    info "正在安装所有常用软件..."
    install_packages nano htop sudo curl docker.io lrzsz openssh-server git
}

uninstall_optional_software() {
    confirm_phrase \
        "⚠️ 将卸载 nano、htop、Docker、lrzsz 和 OpenSSH Server；sudo、curl、git 会保留。" \
        "REMOVE OPTIONAL SOFTWARE" || return 0

    info "正在卸载可选软件..."
    if remove_installed_packages nano htop docker.io lrzsz openssh-server; then
        success "✅ 可选软件卸载完成。"
    else
        error "❌ 可选软件卸载失败。"
        return 1
    fi
}

install_common_software() {
    local software_choice

    while true; do
        clear_screen
        printf '%s安装常用软件%s\n' "$BLUE" "$RESET"
        printf '%s\n' \
            "1. 安装 nano" \
            "2. 安装 htop" \
            "3. 安装 sudo" \
            "4. 安装 curl" \
            "5. 安装 Docker" \
            "6. 安装 lrzsz" \
            "7. 安装 OpenSSH" \
            "8. 安装 Git" \
            "9. 安装所有常用软件" \
            "10. 卸载可选软件（保留 sudo/curl/git）" \
            "0. 返回上级菜单"

        if ! read -r -p "请选择操作 [0-10]: " software_choice; then
            return
        fi

        case "$software_choice" in
            1) install_nano ;;
            2) install_htop ;;
            3) install_sudo ;;
            4) install_curl ;;
            5) install_docker ;;
            6) install_lrzsz ;;
            7) install_openssh ;;
            8) install_git ;;
            9) install_all_common_software ;;
            10) uninstall_optional_software ;;
            0) return ;;
            *) error "无效选项，请重新选择。" ;;
        esac

        pause
    done
}

change_system_language() {
    confirm "将系统默认语言改为 zh_CN.UTF-8，是否继续？" || return 0
    info "正在配置中文语言环境..."

    install_packages locales fonts-wqy-microhei fonts-wqy-zenhei || return 1
    run_root sed -i \
        's/^[#[:space:]]*zh_CN.UTF-8[[:space:]]\+UTF-8/zh_CN.UTF-8 UTF-8/' \
        /etc/locale.gen || return 1
    run_root locale-gen zh_CN.UTF-8 || return 1
    run_root update-locale LANG=zh_CN.UTF-8 || return 1
    success "✅ 系统语言已改为 zh_CN.UTF-8，重新登录后生效。"
}

backup_firewall_rules() {
    local timestamp
    local ipv4_backup
    local ipv6_backup

    timestamp="$(date '+%Y%m%d-%H%M%S')"
    ipv4_backup="/var/backups/iptables-$timestamp.rules"
    ipv6_backup="/var/backups/ip6tables-$timestamp.rules"

    run_root mkdir -p /var/backups || return 1
    run_root sh -c 'iptables-save > "$1"' sh "$ipv4_backup" || return 1
    info "IPv4 防火墙备份：$ipv4_backup"
    run_root sh -c 'ip6tables-save > "$1"' sh "$ipv6_backup" || return 1
    info "IPv6 防火墙备份：$ipv6_backup"
}

open_all_ports() {
    confirm_phrase \
        "⚠️ 高风险：这会清空 IPv4/IPv6 过滤规则并允许所有入站、转发和出站流量。" \
        "OPEN ALL PORTS" || return 0

    info "正在备份并开放所有端口..."
    install_packages iptables netfilter-persistent || return 1
    backup_firewall_rules || return 1

    run_root iptables -P INPUT ACCEPT &&
        run_root iptables -P FORWARD ACCEPT &&
        run_root iptables -P OUTPUT ACCEPT &&
        run_root iptables -F || return 1

    run_root ip6tables -P INPUT ACCEPT &&
        run_root ip6tables -P FORWARD ACCEPT &&
        run_root ip6tables -P OUTPUT ACCEPT &&
        run_root ip6tables -F || return 1

    run_root netfilter-persistent save || return 1
    success "✅ 所有端口已开放。请确认云防火墙和主机安全策略。"
}

remove_default_apps() {
    confirm_phrase \
        "⚠️ 将清理当前已安装的常见桌面应用。" \
        "PURGE DEFAULT APPS" || return 0

    info "正在删除系统自带应用..."
    if remove_installed_packages \
        thunderbird totem rhythmbox empathy brasero simple-scan \
        gnome-mahjongg aisleriot gnome-mines cheese transmission-common \
        gnome-orca gnome-sudoku remmina; then
        success "✅ 已安装的目标应用清理完成。"
    else
        error "❌ 应用清理失败。"
        return 1
    fi
}

remove_desktop_environment() {
    confirm_phrase \
        "⚠️ 极高风险：这会卸载 GNOME 桌面，可能导致图形登录不可用。" \
        "REMOVE DESKTOP" || return 0

    info "正在卸载 GNOME 桌面环境..."
    if remove_installed_packages gnome-shell gnome; then
        success "✅ GNOME 桌面环境卸载完成。"
    else
        error "❌ GNOME 桌面环境卸载失败。"
        return 1
    fi
}

autoremove_unused_dependencies() {
    confirm "apt autoremove 可能删除不再被依赖的软件包，是否继续？" || return 0
    info "正在自动卸载不需要的依赖..."

    if apt_get autoremove -y; then
        success "✅ 不需要的依赖已清理。"
    else
        error "❌ 自动清理失败。"
        return 1
    fi
}

clean_system_cache() {
    info "正在清理 apt 缓存..."
    if apt_get autoclean && apt_get clean; then
        success "✅ apt 缓存清理完成。"
    else
        error "❌ apt 缓存清理失败。"
        return 1
    fi
}

install_git_plugin() {
    local repository="$1"
    local destination="$2"

    if [ -d "$destination/.git" ]; then
        warn "已存在，跳过：$destination"
        return 0
    fi
    if [ -e "$destination" ]; then
        error "❌ 目标路径已存在但不是 Git 仓库：$destination"
        return 1
    fi

    git clone --depth=1 "$repository" "$destination"
}

setup_zsh_environment() {
    local zsh_custom
    local zshrc_tmp
    local zshrc_backup
    local zsh_bin
    local omz_installer
    local omz_status

    confirm "将安装 Oh My Zsh、插件并替换 ~/.zshrc，是否继续？" || return 0
    info "正在准备 zsh 环境..."
    install_packages zsh git curl || return 1

    if [ -f "$HOME/.zshrc" ]; then
        zshrc_backup="$HOME/.zshrc.backup.$(date '+%Y%m%d-%H%M%S')"
        cp -p "$HOME/.zshrc" "$zshrc_backup" || return 1
        info "现有 .zshrc 已备份到：$zshrc_backup"
    fi

    if [ ! -d "$HOME/.oh-my-zsh" ]; then
        info "正在以无人值守模式安装 Oh My Zsh..."
        omz_installer="$(mktemp "${TMPDIR:-/tmp}/oh-my-zsh-install.XXXXXX")" || return 1
        if ! curl -fsSL \
            https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh \
            -o "$omz_installer"; then
            rm -f "$omz_installer"
            error "❌ Oh My Zsh 安装器下载失败。"
            return 1
        fi
        RUNZSH=no CHSH=no KEEP_ZSHRC=yes \
            sh "$omz_installer" --unattended
        omz_status=$?
        rm -f "$omz_installer"
        if [ "$omz_status" -ne 0 ]; then
            error "❌ Oh My Zsh 安装失败。"
            return 1
        fi
    else
        warn "Oh My Zsh 已存在，跳过安装。"
    fi

    zsh_custom="${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}"
    mkdir -p "$zsh_custom/plugins" || return 1
    install_git_plugin \
        https://github.com/zsh-users/zsh-autosuggestions \
        "$zsh_custom/plugins/zsh-autosuggestions" || return 1
    install_git_plugin \
        https://github.com/zsh-users/zsh-syntax-highlighting.git \
        "$zsh_custom/plugins/zsh-syntax-highlighting" || return 1

    zshrc_tmp="$(mktemp "$HOME/.zshrc.tmp.XXXXXX")" || return 1
    if curl -fsSL https://dot.theojs.net/zshrc/linux-debian.zshrc -o "$zshrc_tmp"; then
        if ! chmod 600 "$zshrc_tmp" || ! mv -f "$zshrc_tmp" "$HOME/.zshrc"; then
            rm -f "$zshrc_tmp"
            error "❌ 无法替换 ~/.zshrc，原备份未受影响。"
            return 1
        fi
    else
        rm -f "$zshrc_tmp"
        error "❌ .zshrc 下载失败，原备份未受影响。"
        return 1
    fi

    zsh_bin="$(command -v zsh)"
    if [ "${SHELL:-}" != "$zsh_bin" ]; then
        info "正在将默认 shell 切换为 $zsh_bin..."
        if ! chsh -s "$zsh_bin"; then
            warn "⚠️ 默认 shell 切换失败，可稍后手动运行：chsh -s $zsh_bin"
        fi
    fi

    success "✅ zsh 环境设置完成，请重新登录终端。"
}

safe_optimize_system() {
    confirm "将更新系统、安装常用软件并清理 apt 缓存，是否继续？" || return 0
    update_system || return 1
    install_all_common_software || return 1
    clean_system_cache || return 1
    success "✅ 安全基础优化完成。高风险操作未自动执行。"
}

check_environment() {
    preflight || return 1
    success "✅ 环境检查通过。"
    printf '系统: %s\n' "$OS_NAME"
    printf '用户: %s (uid=%s)\n' "$(id -un)" "$(id -u)"
    printf '权限方式: %s\n' "$(if [ "${#SUDO[@]}" -eq 0 ]; then printf 'root'; else printf 'sudo'; fi)"
    printf 'Bash: %s\n' "${BASH_VERSION:-unknown}"
    printf 'apt-get: %s\n' "$(command -v apt-get)"
}

main_menu() {
    local choice

    while true; do
        clear_screen
        printf '%s「Debian/Ubuntu」系统维护工具%s\n' "$BLUE" "$RESET"
        printf '脚本作者: Theo\n'
        printf 'GitHub 仓库: https://github.com/s-theo/dotfiles\n\n'
        printf '%s\n' \
            "1. 更新系统" \
            "2. 安装/卸载常用软件" \
            "3. 更改系统语言为中文" \
            "4. 开启所有端口（高风险）" \
            "5. 删除系统自带应用（高风险）" \
            "6. 卸载桌面环境（高风险）" \
            "7. 自动卸载不需要的依赖" \
            "8. 清理 apt 缓存" \
            "9. 设置 zsh 环境" \
            "10. 安全基础优化" \
            "0. 退出"

        if ! read -r -p "请选择操作 [0-10]: " choice; then
            printf '\n'
            return
        fi

        case "$choice" in
            1) update_system ;;
            2) install_common_software ;;
            3) change_system_language ;;
            4) open_all_ports ;;
            5) remove_default_apps ;;
            6) remove_desktop_environment ;;
            7) autoremove_unused_dependencies ;;
            8) clean_system_cache ;;
            9) setup_zsh_environment ;;
            10) safe_optimize_system ;;
            0) success "谢谢使用！再见。"; return ;;
            *) error "无效选项，请重新选择。" ;;
        esac

        pause
    done
}

if [ "$#" -gt 1 ]; then
    usage >&2
    exit 2
fi

case "${1:-}" in
    --help|-h)
        usage
        ;;
    --check)
        check_environment
        ;;
    "")
        if [ ! -t 0 ]; then
            error "❌ 交互模式需要终端。仅检查环境请使用 --check。"
            exit 1
        fi
        preflight && main_menu
        ;;
    *)
        usage >&2
        exit 2
        ;;
esac
