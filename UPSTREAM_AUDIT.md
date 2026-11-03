# 官方归档与资源释放核查

核查对象：本机 npm 安装的 `@deepseek-ai/dsh@0.2.1-rc.5`、官方 GitHub 同名发布标签 `dsh-v0.2.1-rc.5`。核查时 `master` 的 workspace 源文件与该标签一致；实现仍以发布标签和本机版本为准。

## 结论

**归档成功不等于会话彻底静止，也不等于资源已释放。**可以复用官方归档的活动检查和阻止后续 AI 步骤的机制；完整释放应另外调用官方 `AgentHandle.dispose()`。归档后直接删除目录不安全。

| 核查点 | 官方实现 |
|---|---|
| 普通归档 | 调用 `workspace/session-activity`；有活动则拒绝，否则写归档集合并移除置顶 |
| 停止并归档 | `stopActivity: true` 先写归档，再发停止请求；不统一等待运行工作彻底结束 |
| 已归档再调用归档 | 直接返回，不重新检查活动，也不重新停止 |
| 后续 AI 步骤 | API Session 的归档门禁会拒绝该会话及其子代理后续步骤 |
| Agent/Session 销毁 | 归档路径没有调用生命周期 `dispose()`，驻留对象可保留 |
| 写入器关闭 | 官方完整销毁流程等待 `whenIdle()`、释放作用域、等待 `handle.close()`，再从 Agent/Session 注册表移除 |
| 投影缓存 | 收到 `session/disposed` 后仍会异步保存最终缓存；插件必须阻止删除后的迟到写回 |

## 原始源码

- [workspace 归档路径](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/workspace/workspace/src/index.ts#L348)
- [Agent 归档停止监听器](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/core/agent/src/archive-admission.ts#L16)
- [后台任务归档监听器](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/jobs/jobs/src/archive-admission.ts#L18)
- [子代理归档监听器](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/subagent/subagent/src/archive-admission.ts#L17)
- [归档会话及祖先门禁](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/api/session-controller/src/archived-session-gate.ts#L43)
- [官方完整销毁链](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/core/agent-loop/src/index.ts#L544)
- [投影缓存最终写回](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/session/session-projection-cache/src/index.ts#L345)

## 实机验证（隔离数据）

`test/integration.mjs` 用合成会话启动本机真实 DSH，打开会话使其驻留，然后调用原生 `workspaceRegistry.archiveSession()`。通过测试专用控制器检查到：

```json
{
  "archived": true,
  "agentResident": true,
  "sessionResident": true,
  "status": "idle",
  "writerOpen": true
}
```

这验证了“已归档，但仍有会话对象和写入句柄”的实际情况。测试控制器只装入临时测试 profile，不随插件分发。

## 插件使用的最小流程

未归档会话：核对确认范围 → 官方归档 → 加删除锁 → 目标及子代理静止核查 → 保存私有目录恢复清单 → 官方生命周期销毁 → 缓存与持久化数据清理 → 验证与完成收据。

已归档会话：进入同一删除流程，原生归档调用是幂等操作。最终核查仍保留，因为已归档入口不会重新验证任务状态。

没有另写一套停止 AI、杀后台任务或关闭子代理的实现。前端使用 DSH 已有的运行状态作为提示；后台只在真正删除前做核查。删除锁、防止迟到缓存写回、共享附件引用分析和崩溃恢复属于 DSH 尚未提供的删除能力。

## 对抗性复核补充

本机 rc.5 的 `FileUploads.stagedFiles` 保存尚未发送的文件上传，销毁 Session 时清除。0.3.0 的会话删除完全不碰附件；独立 GC 会读取仍存活的上传收据以保护其他草稿。Agent Inbox 通过 `agent/inbox/spliced` 同步写入 Session，已经包含在事件快照中，不需要第二套 Inbox 引用扫描。

Agent loop 的并行工具结果按调用顺序提交：后面的工具可能已经存好图片，却仍在等前面的工具结束。日志快照不能单独证明这些附件没有其他用户。因此独立附件 GC 要求本进程其他 Agent 也静止，并在清理期间阻止新的发布；会话私有删除无需这个全局限制。

默认 `LocalSpillStore.root` 可从当前服务实例取得，`saveText` 按 `owner.sessionId` 的哈希写入子目录。历史根及 subprocess 文件没有可用于本插件的持久化会话归属账本；普通文本中出现路径不构成所有权。0.3.0 的删除与附件 GC 都不清理任何 `/tmp` 输出。

完整问题、修复和边界见 [REVIEW.md](REVIEW.md)。
