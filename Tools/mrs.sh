#!/bin/bash
# 批量将指定目录下的 txt 文件转换为 mrs 文件（domain 类型）
# 使用前确保 mihomo 已安装且在 PATH 中

# 提示用户输入目录（相对于脚本执行的根目录）
read -p "请输入要处理的目录（相对于当前根目录，可留空使用默认目录 Proxy/Rules）: " input_dir

# 如果用户没有输入，默认使用 Proxy/Rules
dir="${input_dir:-Proxy/Rules}"

# 检查目录是否存在
if [ ! -d "$dir" ]; then
    echo "目录不存在：$dir"
    exit 1
fi

echo "正在处理目录: $dir"

# 遍历目录下的 txt 文件
shopt -s nullglob
txt_files=("$dir"/*.txt)
if [ ${#txt_files[@]} -eq 0 ]; then
    echo "目录中没有 txt 文件"
    exit 0
fi

for file in "${txt_files[@]}"; do
    # 获取文件名，不带路径和后缀
    filename="$(basename "$file" .txt)"

    # 输出文件名：同目录下
    output="$dir/${filename}.mrs"

    echo "正在转换 $file -> $output ..."

    # 执行 mihomo 转换命令
    mihomo convert-ruleset domain text "$file" "$output"

    if [ $? -eq 0 ]; then
        echo "转换完成：$output"
    else
        echo "转换失败：$file"
    fi
done

echo "所有 txt 文件处理完成！"
