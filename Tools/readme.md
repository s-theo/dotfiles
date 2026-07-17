# Tools

本目录收录规则转换、Linux 系统维护和 OpenClash Smart 内核管理脚本。

## `linux.sh`

面向 Debian/Ubuntu 的交互式系统维护工具，支持软件安装、系统更新、缓存清理和
zsh 环境配置。防火墙放行、桌面卸载等高风险操作需要输入确认短语。

先检查环境，不修改系统：

```sh
./Tools/linux.sh --check
```

启动交互菜单：

```sh
./Tools/linux.sh
```

远程使用时建议先下载并检查脚本：

```sh
curl -fsSLo /tmp/linux.sh https://dot.theojs.cn/Tools/linux.sh
less /tmp/linux.sh
bash /tmp/linux.sh --check
bash /tmp/linux.sh
```

## `mrs.sh`

将文本规则转换为 Mihomo `.mrs` 规则集，运行前需要安装 `mihomo`。

在仓库根目录转换默认的 `Proxy/Rules`：

```sh
pnpm run mrs
```

也可以指定相对于仓库根目录或绝对路径的规则目录：

```sh
./Tools/mrs.sh Proxy/Rules
./Tools/mrs.sh /path/to/rules
```

远程下载：

```sh
curl -fsSLo mrs.sh https://dot.theojs.cn/Tools/mrs.sh
chmod +x mrs.sh
./mrs.sh /path/to/rules
```

脚本会自动识别 domain 与 IP/CIDR 规则，拒绝混合内容，并通过临时文件原子替换
输出文件。

## `smartcore.sh`

Mihomo Smart 内核管理工具 `v1.0.0`，面向 OpenWrt、BusyBox `ash` 和 OpenClash。
支持版本检查、更新、自动更新、失败恢复、更新日志和平台选择。

```sh
./Tools/smartcore.sh --help
./Tools/smartcore.sh --check
./Tools/smartcore.sh --update
./Tools/smartcore.sh --auto
./Tools/smartcore.sh --changelog
./Tools/smartcore.sh --platform linux-amd64-v2 --check
```

远程下载：

```sh
curl -fsSLo smartcore.sh https://dot.theojs.cn/Tools/smartcore.sh
chmod +x smartcore.sh
./smartcore.sh --help
./smartcore.sh --check
```

无参数时启动交互菜单。更新需要 root 权限。脚本会在更新前临时备份当前内核：
安装或重启失败时自动恢复，成功后立即删除备份。计划任务请使用 `--auto`。在
x86_64 设备上，脚本会根据 CPU 指令集自动选择 `v3`、`v2` 或 `compatible`；
`linux-amd64` 会作为自动选择别名处理。
