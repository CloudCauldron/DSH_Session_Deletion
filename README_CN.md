# **DSH 会话删除**

<p align="center">
  <a href="README_CN.md">中文</a> | <a href="README.md">English</a>
</p>

<span style="margin-left:2em;">&#8203;</span>为 **[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)** 提供会话永久删除与孤立附件垃圾回收能力的扩展插件。

## **1 - 项目简介**

<span style="margin-left:2em;">&#8203;</span>DeepSeek Harness `0.2.2-rc.5` 原生仅提供会话归档功能。随着日常使用与多智能体协作的增多，历史会话、子代理记录以及关联的文件和图片附件会长期滞留在本地磁盘中。`dsh-session-deletion` 弥补了这一空缺，为 DSH 带来了两项关键的维护能力：

- **会话删除**：移除目标会话及其子代理的日志与投影缓存，清理工作区中的会话关联及相关配置。
- **残留附件与缓存清理 (GC)**：在 DSH 空闲时回收无引用的本地附件和可重新生成的图片缓存。

## **2 - 核心特性**

- **完整删除会话与子代理**
    支持从主会话操作入口一并清理关联的全部子代理记录。未归档与已归档会话均通过「删除会话」操作；运行中的会话会先停止，再执行删除。
- **细粒度隔离与并发安全**
    删除操作仅针对目标会话及其子代理加锁，其他正在活跃的会话、AI 任务、后台执行与文件上传完全不受干扰。
- **全局孤立附件与缓存回收**
    清理前检查磁盘会话日志、内存中的会话、暂存上传及 DSH 存储中的引用。共享图片在最后一个引用消失后才可回收。

## **3 - 使用指南**

删除会话或使用「释放空间」时，请关闭共用同一数据目录的其他 DSH 实例，等操作结束后再打开。

### **3.1 - 删除会话**

1. 在左侧会话列表中，点击目标会话条目右侧的 `…` 菜单。
2. 选择菜单底部的 **「删除会话」**（位于「归档会话」或「取消归档」下方）。
3. 弹出的确认对话框会提示该会话包含的子代理数量，点击确认即可彻底删除。

删除与清理的范围如下：

| 数据 | 处理方式 |
| :---: | :---: |
| 目标会话及子代理的日志、历史版本、投影缓存及其备份 | 随会话删除 |
| 工作区中的会话关联、归档与置顶记录、关联定时任务 | 随会话删除 |
| 插件识别的浏览器会话状态 | 对应浏览器运行插件后清理 |
| 无引用的本地附件、本地上传映射及可重新生成的图片缓存 | 单独运行 GC 清理 |
| 工具输出临时文件（spill）及 `attachments/v1/tmp/` 中的临时附件 | 保留 |
| 工作区及其路径信息、空项目容器目录、用户保存的项目文件 | 保留 |

其他会话已继承或复制的内容、服务端文件、文件系统快照及备份不属于本插件的删除范围。

### **3.2. 清理残留附件与缓存**

<span style="margin-left:2em;">&#8203;</span>插件将残留附件与缓存的回收独立为单独的清理功能，而非在删除会话时顺带清理，主要是为了保障多会话并发与资源共享时的数据安全：

- **附件可能被多会话共享**：DSH 的本地附件按内容散列值（Hash Value）存储，同一份文件可能被分叉会话、继承的历史记录或其他会话共同引用，无法仅凭所属会话直接判断是否可删。
- **防止并发写入引发误删**：删除单个会话时，其他会话可能正在引用同一附件，或存在尚未写入日志的暂存上传。导入 DeepSeek 聊天记录期间，体积估算和清理均不可用。遇到无法识别的 JSONL 备份时，估算和清理也会停止，保留附件供核查。
- **区分独占与共享缓存**：目标会话独占的投影缓存会随会话直接删除；而请求图片等可重建的共享缓存，则交由全局清理在无相关生成任务运行时安全回收。

通过将二者分开，日常删除会话只需锁定目标会话及其子代理，不会干扰其他活跃任务；仅在需要释放磁盘空间时，才单独承担全局扫描与并发保护的开销。

1. 点击左侧导航栏底部的 **「更多」** 选项。
2. 选择 **「释放空间」**。括号内显示预计可释放的空间，无法估算时显示「大小未知」。
3. 请在所有会话空闲时确认清理。清理完成后，DSH 会显示本次回收的附件和缓存文件数量。

如果清理中断，再次运行「释放空间」即可重新扫描。

### **3.3 - 手动处理未完成的会话删除**

如果 DSH 提示「会话删除未完成」，请先处理这次删除请求。处理完毕后，才能继续删除会话或使用「释放空间」。

1. 关闭所有使用该数据目录的 DSH 进程，包括 DSH 桌面端。等命令运行结束后再打开 DSH。
2. 在 DSH 实际使用的数据目录（`DSH_HOME`，通常是 `~/.dsh`）中打开终端，运行已安装的恢复脚本。命令末尾的 `.` 表示当前目录。如果插件安装在桌面端配置下，请将 `web` 换成 `desktop`。

    ```sh
    node ./profiles/web/node_modules/dsh-session-deletion/lib/guard.js .
    ```

- `Deletion completed for <id>.` 表示该会话及确认删除的子代理都已删除。
- `Deletion abandoned for <id>.` 表示该会话或某个子代理保存在磁盘上的日志已更改或被替换。脚本会清除这次删除请求，保留剩余数据。
- `Nothing pending.` 表示没有待处理的请求。

以上结果的退出码均为 `0`。如果出错，脚本会说明原因并以退出码 `1` 结束。解决提示的问题后再运行即可。

## **4 - 环境要求**

- **DeepSeek Harness**：`0.2.2-rc.5`（CLI 默认 Web 配置或 DSH Desktop）
- **操作系统**：Linux、Windows
- **Node.js**：`>= 24.9.0`

## **5 - 安装与配置**

### **5.1 - 安装插件**

1. 在本仓库目录下构建编译产物：

    ```bash
    pnpm install
    pnpm build
    ```

2. 若 DSH 配置限制了依赖项构建，请在配置文件的 `pnpm-workspace.yaml` 中允许 `koffi`：

    ```yaml
    allowBuilds:
      koffi: true
    ```

3. DSH Desktop 使用内置 CLI，并将以下命令中的 `--profile web` 改为 `--profile desktop`。

    **Linux（Bash）：**

    ```bash
    dsh plugin --profile web add "file:$PWD"
    ```

    **Windows（PowerShell）：**

    ```powershell
    $pnpmDir = Split-Path (Get-Command pnpm.exe -CommandType Application -ErrorAction Stop).Source
    $env:Path = "$pnpmDir;$env:Path"
    dsh plugin --profile web add "file:$($PWD.Path)"
    ```

    **Windows（Git Bash）：**

    ```bash
    pnpm_dir="$(dirname "$(type -P pnpm.exe)")"
    PATH="$pnpm_dir:$PATH" dsh plugin --profile web add "file:$(cygpath -m "$PWD")"
    ```

4. 重启 DSH 服务即可体验。

### **5.2 - 卸载插件**

<span style="margin-left:2em;">&#8203;</span>如有未完成的会话删除，请先处理完毕。运行以下命令卸载插件，然后重启 DSH。

```bash
dsh plugin --profile web remove dsh-session-deletion
```

DSH 停止运行时，也可以删除 `DSH_HOME` 下的插件数据目录 `.dsh-session-deletion`。

## **6 - 开发与测试**

<span style="margin-left:2em;">&#8203;</span>源码与全部测试均使用 TypeScript，构建通过 `@typescript/native` 别名使用 TypeScript 7，`typescript` 别名仅为 ESLint 提供 TypeScript 6 兼容 API，参照 [Microsoft 的并行使用说明](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60)。

浏览器测试使用 Chrome 和本机的 rc.5 CLI。在 Windows 上，请将 `DSH_CLI` 设为已安装的 `@deepseek-ai/dsh/lib/bin.js` 的绝对路径。若 Chrome 安装在非默认位置，请设置 `CHROME_PATH`。

```bash
pnpm lint              # ESLint 正确性与异步检查
pnpm check             # 源码与测试的严格 TypeScript 类型检查
pnpm test              # 运行单元测试
pnpm test:integration  # 使用 Chrome 在独立的 DSH Web 配置中测试
pnpm test:release      # 依次运行全部四项检查
```
