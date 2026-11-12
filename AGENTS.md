# Codebase Conventions

## DSH APIs and UI conventions

- **Reuse existing capabilities:** Leverage built-in DSH APIs and interfaces whenever available instead of reinventing the wheel.
- **Stick to native UI:** Use DSH native controls and default styles by default. Avoid custom styles that introduce code redundancy and visual inconsistency.

## Shell operations

If the codebase is located on Windows system, use Windows native git bash to perform shell operations on Windows.

## Git commit messages

- Both the subject line and the body must be in Simplified Chinese.
- Recommended subject format: `【<类型1>[/<类型2>...]】<简要描述>` — e.g. `修复: 解决番剧详情页加载失败的问题`.
- Common type words:

    ```plaintexr
    构建 → build
    (Build system or dependency changes, such as Webpack configuration modifications)
    杂项 → chore
    (Miscellaneous maintenance unrelated to business logic, such as code formatting)
    集成 → ci
    (Continuous integration configuration changes, such as Jenkins file adjustments)
    文档 → docs
    (Documentation-only updates, such as README modifications)
    性能 → perf
    (Performance optimizations, such as reducing algorithm complexity)
    更新 → feat
    (New features adding, such as adding a new module)
    修复 → fix
    (Bug fixing, such as fixing component render error)
    重构 → refactor
    (Code structure changes without altering functionality, such as module splitting)
    格式 → style
    (Code style adjustments, such as indentation or semicolon fixes)
    测试 → test
    (Adding or modifying test cases, such as completing unit tests)
    回退 → revert
    (Reverting a previous commit, such as undoing an incorrect merge)
    ```

- The body should explain the reason and impact of the change, not enumerate the touched files.

Example:

```plaintext
【修复】解决离线模式下封面图加载报错

离线模式时缓存键拼接遗漏了清晰度后缀，导致命中错误的缓存条目。
```
