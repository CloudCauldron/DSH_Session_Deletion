# **DSH Session Deletion**

<span style="margin-left:2em;">​</span>An extension plugin for **[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)** that provides permanent session deletion and orphaned attachment garbage collection.

## **1 - Overview**

<span style="margin-left:2em;">​</span>Out of the box, DeepSeek Harness `0.2.2-rc.5` only supports session archiving. As daily usage and multi-agent collaboration grow, historical sessions, subagent records, and associated file and image attachments remain on the local disk indefinitely. `dsh-session-deletion` fills this gap by bringing two key maintenance capabilities to DSH:

- **Session Deletion**: Removes the logs and projection caches of the target session and its subagents, and cleans up session associations and related configurations in the workspace.
- **Orphaned Attachment and Cache Cleanup (GC)**: Intelligently scans all live sessions when the system is idle to accurately identify and clean up unreferenced orphaned attachments and local image caches, freeing up disk space.

## **2 - Key Features**

- **Complete Deletion of Sessions and Subagents**
    Supports cleaning up all linked subagent records together from the main session action menu. Both unarchived and archived sessions are deleted via "Delete Session"; running sessions are stopped first before deletion is executed.
- **Fine-Grained Isolation and Concurrency Safety**
    Deletion operations lock only the target session and its subagents, leaving other active sessions, AI tasks, background executions, and file uploads completely undisturbed.
- **Global Orphaned Attachment and Cache Reclamation**
    Provides a dedicated garbage collection feature. Safely scans actual references across all active sessions and removes only confirmed unlinked orphaned attachments and temporary image caches, preventing accidental deletion of valid data.
- **Automatic Recovery from Unexpected Interruptions**
    Uses a transactional mechanism. If a power outage or abnormal process termination occurs during cleanup, DSH automatically resumes and completes unfinished deletions on the next startup, preventing data inconsistency or leftover remnants.

## **3 - User Guide**

### **3.1 - Deleting a Session**

1. In the left session list, click the `…` menu on the right side of the target session item.
2. Select **"Delete Session"** at the bottom of the menu (below "Archive Session" or "Unarchive").
3. The confirmation dialog will display the number of subagents included in the session. Click confirm to permanently delete it.

The scope of deletion and cleanup is as follows:

| Data | Handling |
| :---: | :---: |
| Logs, historical versions, projection caches, and their backups for the target session and subagents | Deleted with the session |
| Session associations in the workspace, archive and pin records, and linked scheduled tasks | Deleted with the session |
| Browser session state recognized by the plugin | Cleaned up after the plugin runs in the corresponding browser |
| Unreferenced local attachments, local upload mappings, and regenerable image caches | Cleaned up by running GC separately |
| Tool output temporary files (spill) and staged upload files | Not reclaimed by the plugin |
| Workspaces and their path information, empty project container directories, and user-saved project files | Retained |

Content already inherited or copied by other sessions, server-side files, and filesystem snapshots and backups are outside the deletion scope of this plugin.

### **3.2. Cleaning Up Orphaned Attachments and Cache**

<span style="margin-left:2em;">​</span>The plugin separates the reclamation of orphaned attachments and caches into a standalone cleanup feature rather than performing it alongside session deletion, primarily to ensure data safety during multi-session concurrency and resource sharing:

- **Attachments May Be Shared Across Multiple Sessions**: DSH stores local attachments by content hash value. The same file may be jointly referenced by forked sessions, inherited history, or other sessions, making it impossible to determine whether it can be deleted based solely on the owning session.
- **Preventing Accidental Deletion from Concurrent Writes**: While a single session is being deleted, other sessions might be referencing the same attachment or holding staged uploads not yet written to logs. Global cleanup uniformly inspects references across all live sessions, in-memory snapshots, and staging areas when the system is idle, while blocking new related writes during scanning and deletion.
- **Distinguishing Exclusive vs. Shared Caches**: Projection caches exclusive to the target session are deleted directly with the session, whereas rebuildable shared caches (such as request images) are safely reclaimed by global cleanup when no related generation tasks are running.

By separating the two, routine session deletion only needs to lock the target session and its subagents without disturbing other active tasks; the overhead of global scanning and concurrency protection is incurred only when you explicitly need to free up disk space.

1. Click **"More"** at the bottom of the left navigation sidebar.
2. Select **"Free Up Space"**. The menu shows how much space can be reclaimed, or **"Size unknown"** if the estimate is unavailable.
3. After confirmation, the system completes the scan and cleanup while idle, and displays the number of reclaimed resource items upon completion.

## **4 - Requirements**

- **DeepSeek Harness**: `0.2.2-rc.5` (CLI default Web profile or DSH Desktop)
- **Operating System**: Linux, Windows
- **Node.js**: `>= 24.9.0`

## **5 - Installation and Configuration**

### **5.1 - Installing the Plugin**

When upgrading, let the previous version finish pending deletions and stop DSH before switching versions.

1. Build the compiled artifacts in this repository directory:

    ```bash
    pnpm install
    pnpm build
    ```

2. If your DSH configuration restricts dependency builds, allow `koffi` in the configuration's `pnpm-workspace.yaml`:

    ```yaml
    allowBuilds:
      koffi: true
    ```

3. For DSH Desktop, use the bundled CLI and replace `--profile web` with `--profile desktop` in the commands below.

    **Linux (Bash):**

    ```bash
    dsh plugin --profile web add "file:$PWD"
    ```

    **Windows (PowerShell):**

    ```powershell
    $pnpmDir = Split-Path (Get-Command pnpm.exe -CommandType Application -ErrorAction Stop).Source
    $env:Path = "$pnpmDir;$env:Path"
    dsh plugin --profile web add "file:$($PWD.Path)"
    ```

    **Windows (Git Bash):**

    ```bash
    pnpm_dir="$(dirname "$(type -P pnpm.exe)")"
    PATH="$pnpm_dir:$PATH" dsh plugin --profile web add "file:$(cygpath -m "$PWD")"
    ```

4. Restart the DSH service to start using the plugin.

### **5.2 - Uninstalling the Plugin**

<span style="margin-left:2em;">​</span>To remove the plugin, run the following command and restart DSH:

```bash
dsh plugin --profile web remove dsh-session-deletion
```

After any pending recovery deletions have finished and DSH is stopped, you can optionally delete the `.dsh-session-deletion` directory under your actual `DSH_HOME`; the default location is `~/.dsh/.dsh-session-deletion`.

## **6 - Development and Testing**

<span style="margin-left:2em;">​</span>All source code and tests are written in TypeScript. Builds still use TypeScript 7 via the `@typescript/native` alias, while the `typescript` alias provides the TypeScript 6 compatibility API solely for ESLint, following [Microsoft's side-by-side instructions](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60).

```bash
pnpm lint              # ESLint correctness and async checks
pnpm check             # Strict TypeScript type checking for source and tests
pnpm test              # Run unit tests
pnpm test:integration  # Exercise an isolated DSH Web profile in Chrome
pnpm test:release      # Run all four checks
```
