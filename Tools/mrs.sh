#!/bin/bash
# 批量将当前目录和上级目录下的 txt 文件转换为 mrs 文件（domain 类型）
# 使用前确保 mihomo 已安装且在 PATH 中

# 要处理的目录数组：当前目录和上级目录
dirs=("." "..")

for dir in "${dirs[@]}"; do
    echo "正在处理目录: $dir"
    
    for file in "$dir"/*.txt; do
        [ -e "$file" ] || continue  # 如果没有 txt 文件就跳过

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
done

echo "所有 txt 文件处理完成！"
