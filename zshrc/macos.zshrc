# 设置环境变量
export PATH="/usr/local/sbin:$PATH"
export ZSH="$HOME/.oh-my-zsh"
FPATH=$(brew --prefix)/share/zsh-completions:$FPATH

# 主题配置
ZSH_THEME="awesomepanda"

# 大小写敏感配置
# CASE_SENSITIVE="true"

# 取消注释以使连字符和下划线互换
# HYPHEN_INSENSITIVE="true"

# 取消注释以下行之一以配置自动更新行为
# zstyle ':omz:update' mode disabled  # 禁用自动更新
# zstyle ':omz:update' mode auto      # 自动更新，无需询问
# zstyle ':omz:update' mode reminder  # 提醒更新

# 取消注释以下行以更改自动更新频率（天数）
# zstyle ':omz:update' frequency 13

# Homebrew API Token
export HOMEBREW_GITHUB_API_TOKEN=

# 取消注释以下行以禁用 Homebrew 自动更新
# export HOMEBREW_NO_AUTO_UPDATE="true"
# Homebrew 自动更新间隔（秒）
export HOMEBREW_AUTO_UPDATE_SECS=86400

# 取消注释以下行以避免 URL 粘贴混乱
DISABLE_MAGIC_FUNCTIONS="true"

# 取消注释以下行以禁用 ls 命令中的颜色
# DISABLE_LS_COLORS="true"

# 取消注释以下行以禁用自动设置终端标题
# DISABLE_AUTO_TITLE="true"

# 启用命令自动更正
ENABLE_CORRECTION="true"

# 显示命令补全等待点
COMPLETION_WAITING_DOTS="true"

# 取消注释以下行以禁用未跟踪文件标记（提高大型存储库的性能）
# DISABLE_UNTRACKED_FILES_DIRTY="true"

# 取消注释以下行以更改历史命令的时间戳格式
# HIST_STAMPS="mm/dd/yyyy"

# 设置自定义文件夹（如果需要）
# ZSH_CUSTOM=/path/to/new-custom-folder

# 插件设置
plugins=(git autojump zsh-syntax-highlighting zsh-autosuggestions zsh-completions)

# 加载 oh-my-zsh
source $ZSH/oh-my-zsh.sh

# 用户配置
# 设置 MANPATH（如果需要）
# export MANPATH="/usr/local/man:$MANPATH"

# 设置语言环境（如果需要） 
export LANG=zh_CN.UTF-8
export LANGUAGE=zh_CN.UTF-8

# 配置首选编辑器
# if [[ -n $SSH_CONNECTION ]]; then
#   export EDITOR='vim'
# else
#   export EDITOR='mvim'
# fi

# 编译标志
# export ARCHFLAGS="-arch x86_64"

# 设置个人别名，覆盖 oh-my-zsh 库的别名
alias pn="pnpm"
alias cz="git-cz"
alias gs="git status"
alias ga="git add -A"
alias gc="git commit -m"
alias gp="git push origin HEAD"

# 配置 pnpm
export PNPM_HOME="/Users/theo/Library/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac


# 配置 nvm
export NVM_DIR="$HOME/.nvm"
source "$NVM_DIR/nvm.sh"
export PATH=$HOME/.nvm/versions/node/v24.2.0/bin:$PATH

# 配置 GPG
export GPG_TTY=$(tty)

# 配置 autojump
[[ -s $(brew --prefix)/etc/profile.d/autojump.sh ]] && . $(brew --prefix)/etc/profile.d/autojump.sh

# 配置nano
export PATH="/opt/homebrew/opt/nano/bin:$PATH"
