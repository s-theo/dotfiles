# Tools

本目录收录规则转换、Linux 系统维护和 OpenClash Smart 内核管理脚本。远程命令会
在当前目录下载并保留脚本，然后赋予执行权限并立即运行。

## `linux.sh`

面向 Debian/Ubuntu 的交互式系统维护工具，支持软件安装、系统更新、缓存清理和
zsh 环境配置。防火墙放行、桌面卸载等高风险操作需要输入确认短语。

一行下载并启动：

```sh
curl -fsSLo linux.sh https://dot.theojs.net/Tools/linux.sh && chmod +x linux.sh && ./linux.sh
```

一行下载并检查环境，不修改系统：

```sh
curl -fsSLo linux.sh https://dot.theojs.net/Tools/linux.sh && chmod +x linux.sh && ./linux.sh --check
```

## `mrs.sh`

将目录中的文本规则转换为 Mihomo `.mrs` 规则集。运行前需要安装 `mihomo`，规则
目录请使用绝对路径。

一行下载并转换：

```sh
curl -fsSLo mrs.sh https://dot.theojs.net/Tools/mrs.sh && chmod +x mrs.sh && ./mrs.sh /path/to/rules
```

在本仓库根目录转换 `Proxy/Rules`：

```sh
pnpm run mrs
```

脚本会自动识别 domain 与 IP/CIDR 规则，拒绝混合内容，并通过临时文件原子替换
输出文件。

## `smartcore.sh`

Mihomo Smart 内核管理工具 `v1.0.0`，面向 OpenWrt、BusyBox `ash` 和 OpenClash。
支持版本检查、交互更新、自动更新、失败恢复、更新日志和平台自动选择。

一行下载并启动：

```sh
curl -fsSLo smartcore.sh https://dot.theojs.net/Tools/smartcore.sh && chmod +x smartcore.sh && ./smartcore.sh
```

一行下载并自动更新，适合计划任务：

```sh
curl -fsSLo smartcore.sh https://dot.theojs.net/Tools/smartcore.sh && chmod +x smartcore.sh && ./smartcore.sh --auto
```

内核直接来自
[`vernesong/mihomo` 的 `Prerelease-Alpha` Release](https://github.com/vernesong/mihomo/releases/tag/Prerelease-Alpha)，
并使用官方 `checksums.txt` 验证 SHA-256。更新前会临时备份当前内核：安装或重启
失败时自动恢复，成功后立即删除备份。

在 x86_64 设备上，脚本会根据 CPU 指令集自动选择 `v3`、`v2` 或 `compatible`。
远程一行命令会将脚本保存到当前目录，以后可以直接运行对应的本地文件。
