#!/bin/bash

# 函数：更新系统
update_system() {
    echo -e "\n\e[1;34m正在更新系统...\e[0m"
    sudo apt update && sudo apt upgrade -y
    echo -e "\n\e[1;34m系统更新完成!\e[0m"
}

# 函数：安装 nano
install_nano() {
    echo -e "\n\e[1;34m正在安装 nano...\e[0m"
    sudo apt install -y nano
    echo -e "\n\e[1;34mnano 安装完成!\e[0m"
}

# 函数：安装 htop
install_htop() {
    echo -e "\n\e[1;34m正在安装 htop...\e[0m"
    sudo apt install -y htop
    echo -e "\n\e[1;34mhtop 安装完成!\e[0m"
}

# 函数：安装 sudo
install_sudo() {
    echo -e "\n\e[1;34m正在安装 sudo...\e[0m"
    sudo apt install -y sudo
    echo -e "\n\e[1;34msudo 安装完成!\e[0m"
}

# 函数：安装 curl
install_curl() {
    echo -e "\n\e[1;34m正在安装 curl...\e[0m"
    sudo apt install -y curl
    echo -e "\n\e[1;34mcurl 安装完成!\e[0m"
}

# 函数：安装 Docker
install_docker() {
    echo -e "\n\e[1;34m正在安装 Docker...\e[0m"
    sudo apt install -y docker.io
    echo -e "\n\e[1;34mDocker 安装完成!\e[0m"
}

# 函数：安装 lrzsz
install_lrzsz() {
    echo -e "\n\e[1;34m正在安装 lrzsz...\e[0m"
    sudo apt install -y lrzsz
    echo -e "\n\e[1;34mlrzsz 安装完成!\e[0m"
}

# 函数：安装 OpenSSH
install_openssh() {
    echo -e "\n\e[1;34m正在安装 OpenSSH...\e[0m"
    sudo apt install -y openssh-server
    echo -e "\n\e[1;34mOpenSSH 安装完成!\e[0m"
}

# 函数：安装 Git
install_git() {
    echo -e "\n\e[1;34m正在安装 Git...\e[0m"
    sudo apt install -y git
    echo -e "\n\e[1;34mGit 安装完成!\e[0m"
}

# 函数：安装所有常用软件
install_all_common_software() {
    install_nano
    install_htop
    install_sudo
    install_curl
    install_docker
    install_lrzsz
    install_openssh
    install_git
    echo -e "\n\e[1;34m所有常用软件安装完成!\e[0m"
}

# 函数：卸载所有常用软件
uninstall_all_common_software() {
    echo -e "\n\e[1;34m正在卸载所有常用软件...\e[0m"
    sudo apt remove -y nano htop sudo curl docker.io lrzsz openssh-server git
    echo -e "\n\e[1;34m所有常用软件卸载完成!\e[0m"
}

# 函数：安装常用软件
install_common_software() {
    while true; do
        clear
        echo -e "\e[1;34m安装常用软件\e[0m"
        echo -e "1. 安装 nano"
        echo -e "2. 安装 htop"
        echo -e "3. 安装 sudo"
        echo -e "4. 安装 curl"
        echo -e "5. 安装 Docker"
        echo -e "6. 安装 lrzsz"
        echo -e "7. 安装 OpenSSH"
        echo -e "8. 安装 Git"
        echo -e "9. 安装所有常用软件"
        echo -e "10. 卸载所有常用软件"
        echo -e "0. 返回上级菜单"

        read -p "请选择操作 [0-10]: " software_choice
        case $software_choice in
            1) install_nano ;;
            2) install_htop ;;
            3) install_sudo ;;
            4) install_curl ;;
            5) install_docker ;;
            6) install_lrzsz ;;
            7) install_openssh ;;
            8) install_git ;;
            9) install_all_common_software ;;
            10) uninstall_all_common_software ;;
            0) return ;;
            *) echo -e "\n\e[1;31m无效选项，请重新选择。\e[0m\n";;
        esac

        read -p "按 Enter 键继续..."
    done
}

# 函数：更改系统语言为中文
change_system_language() {
    echo -e "\n\e[1;34m正在更改系统语言为中文...\e[0m"

    # 编辑 /etc/locale.gen 文件，取消注释 zh_CN.UTF-8 和 zh_CN 行
    sudo sed -i '/zh_CN.UTF-8/s/^# //g' /etc/locale.gen
    sudo sed -i '/zh_CN/s/^# //g' /etc/locale.gen

    # 生成本地化设置
    sudo locale-gen zh_CN.UTF-8

    # 更新系统的默认语言设置为 zh_CN.UTF-8
    sudo update-locale LANG=zh_CN.UTF-8

    # 修复Debian系统下的中文乱码
    echo -e "\n\e[1;34m正在修复 Debian 系统下的中文乱码...\e[0m"
    sudo apt install -y ttf-wqy-microhei ttf-wqy-zenhei xfonts-intl-chinese
    echo -e "\n\e[1;34m中文字体安装完成!\e[0m"
    echo -e "\n\e[1;34m系统语言更改完成!\e[0m"
}

# 函数：开启所有端口
open_all_ports() {
    echo -e "\n\e[1;34m正在开启所有端口...\e[0m"
    sudo apt install -y iptables netfilter-persistent
    sudo iptables -P INPUT ACCEPT
    sudo iptables -P FORWARD ACCEPT
    sudo iptables -P OUTPUT ACCEPT
    sudo iptables -F
    sudo netfilter-persistent save
    echo -e "\n\e[1;34m所有端口开启完成!\e[0m"
}

# 函数：删除系统自带软件
remove_default_apps() {
    echo -e "\n\e[1;34m正在删除系统自带软件...\e[0m"
    sudo apt purge -y thunderbird totem rhythmbox empathy brasero simple-scan gnome-mahjongg aisleriot gnome-mines cheese transmission-common gnome-orca gnome-sudoku remmina
    echo -e "\n\e[1;34m系统自带软件删除完成!\e[0m"
}

# 函数：卸载桌面环境
remove_desktop_environment() {
    echo -e "\n\e[1;34m正在卸载桌面环境...\e[0m"
    sudo apt purge -y gnome-shell gnome
    echo -e "\n\e[1;34m桌面环境卸载完成!\e[0m"
}

# 函数：自动卸载不需要的依赖
autoremove_unused_dependencies() {
    echo -e "\n\e[1;34m正在自动卸载不需要的依赖...\e[0m"
    sudo apt autoremove -y
    echo -e "\n\e[1;34m不需要的依赖卸载完成!\e[0m"
}

# 函数：清理缓存
clean_system_cache() {
    echo -e "\n\e[1;34m正在清理缓存...\e[0m"
    sudo apt autoclean
    sudo apt clean
    echo -e "\n\e[1;34m缓存清理完成!\e[0m"
}

# 函数：整体优化选项
optimize_system() {
    update_system
    install_common_software
    change_system_language
    open_all_ports
    remove_default_apps
    remove_desktop_environment
    autoremove_unused_dependencies
    clean_system_cache
    echo -e "\n\e[1;32m所有操作完成！\e[0m"
    echo -e "\e[1;33m请使用 reboot 重启您的系统以应用所有更改。\e[0m"
}


# 函数：设置 zsh 环境
setup_zsh_environment() {

    # 下载 zsh
    echo -e "\n\e[1;34m正在下载 zsh...\e[0m"
    sudo apt update
    sudo apt install -y zsh
    echo -e "\n\e[1;34mzsh 下载完成!\e[0m"

    # 切换到 zsh
    echo -e "\n\e[1;34m正在切换到 zsh...\e[0m"
    chsh -s $(which zsh)
    echo -e "\n\e[1;34m切换到 zsh 完成!\e[0m"

    # 下载 git
    echo -e "\n\e[1;34m正在下载 git...\e[0m"
    sudo apt install -y git
    echo -e "\n\e[1;34mgit 下载完成!\e[0m"

    # 下载 oh-my-zsh
    echo -e "\n\e[1;34m正在下载 oh-my-zsh...\e[0m"
    sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
    echo -e "\n\e[1;34moh-my-zsh 下载完成!\e[0m"

    # 安装插件 zsh-autosuggestions
    echo -e "\n\e[1;34m正在安装 zsh-autosuggestions 插件...\e[0m"
    git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions
    echo -e "\n\e[1;34mzsh-autosuggestions 插件安装完成!\e[0m"

    # 安装插件 zsh-syntax-highlighting
    echo -e "\n\e[1;34m正在安装 zsh-syntax-highlighting 插件...\e[0m"
    git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting
    echo -e "\n\e[1;34mzsh-syntax-highlighting 插件安装完成!\e[0m"

    # 复制 .zshrc 文件
    echo -e "\n\e[1;34m正在复制 .zshrc 文件到本地...\e[0m"
    curl -fsSL https://dot.theojs.cn/zshrc/linux-debian.zshrc -o ~/.zshrc
    echo -e "\n\e[1;34m.zshrc 文件复制完成!\e[0m"

    # 完成提示
    echo -e "\n\e[1;32m设置完成！\e[0m"
    echo -e "\e[1;33m请重新启动您的终端以开始使用 zsh。\e[0m"
}

# 主菜单
while true; do
    clear
    echo -e "\e[1;34m「Debian/Ubuntu」 系统优化选项\e[0m"
    echo -e "脚本作者: Theo"
    echo -e "GitHub 仓库: https://github.com/s-theo/dotfiles"
        
    echo  # 空一行
    
    echo -e "1. 更新系统"
    echo -e "2. 安装常用软件"
    echo -e "3. 更改系统语言为中文"
    echo -e "4. 开启所有端口"
    echo -e "5. 删除系统自带软件"
    echo -e "6. 卸载桌面环境"
    echo -e "7. 自动卸载不需要的依赖"
    echo -e "8. 清理缓存"
    echo -e "9. 设置 zsh 环境"
    echo -e "10. 一键优化系统"

    echo -e "0. 退出"

    read -p "请选择操作 [0-10]: " choice
    case $choice in
        1) update_system ;;
        2) install_common_software ;;
        3) change_system_language ;;
        4) open_all_ports ;;
        5) remove_default_apps ;;
        6) remove_desktop_environment ;;
        7) autoremove_unused_dependencies ;;
        8) clean_system_cache ;;
        9) setup_zsh_environment ;;
        10) optimize_system ;;
        0) echo -e "\n\e[1;32m谢谢使用！再见。\e[0m\n"; exit ;;
        *) echo -e "\n\e[1;31m无效选项，请重新选择。\e[0m\n";;
    esac

    read -p "按 Enter 键继续..."
done
