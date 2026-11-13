# **DSH 会话删除与附件清理插件 (dsh-session-deletion)**

<span style="margin-left:2em;">​</span>为 **[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)** 提供会话永久删除与孤立附件垃圾回收能力的扩展插件。

## **1 - 项目简介**

<span style="margin-left:2em;">​</span>DeepSeek Harness `0.2.2-rc.2` 原生仅提供会话归档功能。随着日常使用与多智能体协作的增多，历史会话、子代理记录以及关联的文件和图片附件会长期滞留在本地磁盘中。`dsh-session-deletion` 弥补了这一空缺，为 DSH 带来了两项关键的维护能力：

- **会话删除**：移除目标会话及其子代理的日志与投影缓存，清理工作区中的会话关联及相关配置。
- **残留附件与缓存清理 (GC)**：在系统空闲时智能扫描所有存活会话，精准识别并清理无引用的孤立附件与本地图片缓存，释放磁盘空间。

## **2 - 核心特性**

- **完整删除会话与子代理**
    支持从主会话操作入口一并清理关联的全部子代理记录。未归档与已归档会话均通过「删除会话」操作，未归档会话会先自动归档。
- **细粒度隔离与并发安全**
    删除操作仅针对目标会话及其子代理加锁，其他正在进行的会话、AI 任务、后台执行与文件上传完全不受干扰。
- **全局孤立附件与缓存回收**
    提供专用的垃圾回收功能。安全扫描所有活跃会话的实际引用，只清理确认无关联的残留附件与临时图片缓存，杜绝误删有效数据。
- **异常中断自动恢复**
    采用事务化机制。若在清理过程中遭遇断电或进程异常退出，DSH 下次启动时会自动恢复未完成的删除，防止数据出现不一致或残留。

## **3 - 使用指南**

### **3.1 - 删除会话**

1. 在左侧会话列表中，点击目标会话条目右侧的 `…` 菜单。
2. 选择菜单底部的 **「删除会话」**（位于「归档会话」或「取消归档」下方）。
3. 弹出的确认对话框会提示该会话包含的子代理数量，点击确认即可彻底删除。

删除与清理的范围如下：

| 数据 | 处理方式 |
| --- | --- |
| 目标会话及子代理的日志、历史版本、投影缓存及其备份 | 随会话删除 |
| 工作区中的会话关联、归档与置顶记录、关联定时任务 | 随会话删除 |
| 插件识别的浏览器会话状态 | 对应浏览器运行插件后清理 |
| 无引用的本地附件、本地上传映射及可重新生成的图片缓存 | 单独运行 GC 清理 |
| 工具输出临时文件（spill）、上传暂存文件 | 插件不回收 |
| 工作区及其路径信息、空项目容器目录、用户保存的项目文件 | 保留 |

其他会话已继承或复制的内容、服务端文件、文件系统快照及备份不属于本插件的删除范围。

### **3.2. 清理残留附件与缓存**

1. 点击左侧导航栏底部的 **「更多」** 选项。
2. 选择 **「清理残留附件与缓存（大小）」**。菜单打开后会估算可清理附件与缓存的体积，按 B、KiB、MiB、GiB、TiB 自动显示（1024 进制）；计算期间括号内显示原生加载圆圈，失败或扫描期间会话、暂存附件发生变化时显示「无法计算体积」，重新打开菜单可重试。实际清理仍会重新扫描确认。
3. 确认后系统将在空闲状态下完成扫描与清理，并在完成后显示本次释放的资源项数。

## **4 - 环境要求**

- **DeepSeek Harness**：`0.2.2-rc.2`（CLI 默认 Web 配置或 DSH Desktop）
- **操作系统**：Linux、Windows
- **Node.js**：`>= 24.9.0`

## **5 - 安装与配置**

### **5.1 - 安装插件**

1. 在本仓库目录下构建编译产物：

    ```bash
    pnpm install
    pnpm build
    ```

2. 将插件注册到 DSH 的 Web profile：

    DSH Desktop 使用内置 CLI，并将以下命令中的 `--profile web` 改为 `--profile desktop`。

    Linux（Bash）：

    ```bash
    dsh plugin --profile web add "file:$PWD"
    ```

    Windows（PowerShell）：

    ```powershell
    dsh plugin --profile web add "file:$($PWD.Path)"
    ```

    Windows（Git Bash）：

    ```bash
    dsh plugin --profile web add "file:$(cygpath -m "$PWD")"
    ```

3. 如果你的工作区 `pnpm-workspace.yaml` 对原生依赖构建有安全限制，请确保允许 `koffi`：

    ```yaml
    allowBuilds:
      koffi: true
    ```

4. 重启 DSH 服务即可体验。

插件清单仅显示一个 `dsh-session-deletion` 入口。中文界面中显示名称为 **「DSH 会话删除」**，英文界面中为 **「DSH Session Deletion」**；其他语言回退到英文名称。内部恢复、删除运行时与 HTTP 模块由该入口统一管理。

### **5.2 - 卸载插件**

如需移除插件，运行以下命令并重启 DSH：

```bash
dsh plugin --profile web remove dsh-session-deletion
```

完成待恢复删除并停止 DSH 后，按需删除实际 `DSH_HOME` 下的 `session-deletion` 目录；默认位置为 `~/.dsh/session-deletion`。

## **6 - 开发与测试**

源码与全部测试均使用 TypeScript，建仍通过 `@typescript/native` 别名使用 TypeScript 7，`typescript` 别名仅为 ESLint 提供 TypeScript 6 兼容 API，参照 [Microsoft 的并行使用说明](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60)。

```bash
pnpm lint              # ESLint 正确性与异步检查
pnpm check             # 源码与测试的严格 TypeScript 类型检查
pnpm test              # 运行单元测试
pnpm test:integration  # 运行集成测试
```

界面文案和删除、清理被拒绝时的提示分别维护在 `locale/zh.json` 与 `locale/en.json` 的 `messages` 中。修改文案时同步维护两种语言，保留键名及 `{title}`、`{count}`、`{size}`、`{kind}`、`{detail}` 等占位符；`meta.title` 仍单独控制插件名称。未翻译的条目回退到中文。重新安装插件并重启 DSH 后加载更新的语言文件。
