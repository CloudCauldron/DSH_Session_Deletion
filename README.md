# **DSH Session Deletion**

<p align="center">
  <a href="README_CN.md">中文</a> | <a href="README.md">English</a>
</p>

<span style="margin-left:2em;">&#8203;</span>An extension plugin for **[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)** that provides permanent session deletion and orphaned attachment garbage collection.

## **1 - Overview**

<span style="margin-left:2em;">&#8203;</span>Out of the box, DeepSeek Harness `0.2.2-rc.5` only supports session archiving. As daily usage and multi-agent collaboration grow, historical sessions, subagent records, and associated file and image attachments remain on the local disk indefinitely. `dsh-session-deletion` fills this gap by bringing two key maintenance capabilities to DSH:

- **Session Deletion**: Removes the logs and projection caches of the target session and its subagents, and cleans up session associations and related configurations in the workspace.
- **Orphaned Attachment and Cache Cleanup (GC)**: Reclaims unreferenced local attachments and regenerable image caches when DSH is idle.

## **2 - Key Features**

- **Complete Deletion of Sessions and Subagents**
    Supports cleaning up all linked subagent records together from the main session action menu. Both unarchived and archived sessions are deleted via "Delete Session"; running sessions are stopped first before deletion is executed.
- **Fine-Grained Isolation and Concurrency Safety**
    Deletion operations lock only the target session and its subagents, leaving other active sessions, AI tasks, background executions, and file uploads completely undisturbed.
- **Global Orphaned Attachment and Cache Reclamation**
    Checks persisted session logs, live sessions, staged uploads, and DSH storage before removing orphaned attachments. A shared image becomes reclaimable after its last reference disappears.

## **3 - User Guide**

When deleting a session or using **Free Up Space**, keep only one DSH instance running against that data directory until the operation finishes.

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
| Tool-output spill files and temporary attachment files in `attachments/v1/tmp/` | Retained |
| Workspaces and their path information, empty project container directories, and user-saved project files | Retained |

Content already inherited or copied by other sessions, server-side files, and filesystem snapshots and backups are outside the deletion scope of this plugin.

### **3.2. Cleaning Up Orphaned Attachments and Cache**

<span style="margin-left:2em;">&#8203;</span>The plugin separates the reclamation of orphaned attachments and caches into a standalone cleanup feature rather than performing it alongside session deletion, primarily to ensure data safety during multi-session concurrency and resource sharing:

- **Attachments May Be Shared Across Multiple Sessions**: DSH stores local attachments by content hash value. The same file may be jointly referenced by forked sessions, inherited history, or other sessions, making it impossible to determine whether it can be deleted based solely on the owning session.
- **Preventing Accidental Deletion from Concurrent Writes**: While a single session is being deleted, other sessions might be referencing the same attachment or holding staged uploads not yet written to logs. While DeepSeek chat import is active, both the size estimate and cleanup are unavailable. An unrecognized JSONL backup also stops both operations so its attachments can be reviewed.
- **Distinguishing Exclusive vs. Shared Caches**: Projection caches exclusive to the target session are deleted directly with the session, whereas rebuildable shared caches (such as request images) are safely reclaimed by global cleanup when no related generation tasks are running.

By separating the two, routine session deletion only needs to lock the target session and its subagents without disturbing other active tasks; the overhead of global scanning and concurrency protection is incurred only when you explicitly need to free up disk space.

1. Click **"More"** at the bottom of the left navigation sidebar.
2. Select **"Free Up Space"**. The menu shows how much space can be reclaimed, or **"Size unknown"** if the estimate is unavailable.
3. Confirm cleanup when all sessions are idle. DSH displays the number of reclaimed attachments and cache files.

If cleanup is interrupted, run **Free Up Space** again for a fresh scan.

### **3.3 - Manual Recovery After an Interrupted Session Deletion**

If DSH shows “Session deletion is incomplete”, new deletions and **Free Up Space** are unavailable until you resolve the pending request.

1. Stop every DSH process that uses the affected data directory, including DSH Desktop. Keep them stopped until the command finishes.
2. Open a terminal in the data directory that DSH was using (`DSH_HOME`, usually `~/.dsh`). Run the installed guard from there. The final `.` passes that directory to the guard. If you installed the plugin in the Desktop profile, replace `web` with `desktop`.

    ```sh
    node ./profiles/web/node_modules/dsh-session-deletion/lib/guard.js .
    ```

- `Deletion completed for <id>.` means the guard finished deleting the session and its confirmed subagents.
- `Deletion abandoned for <id>.` means a saved log for the session or one of its subagents changed or was replaced. The guard clears the request and keeps everything that remains.
- `Nothing pending.` means there were no requests to resolve.

These outcomes return exit code `0`. On an error, the guard prints the reason and exits with code `1`. Address the reported problem before running it again.

## **4 - Requirements**

- **DeepSeek Harness**: `0.2.2-rc.5` (CLI default Web profile or DSH Desktop)
- **Operating System**: Linux, Windows
- **Node.js**: `>= 24.9.0`

## **5 - Installation and Configuration**

### **5.1 - Installing the Plugin**

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

<span style="margin-left:2em;">&#8203;</span>If a session deletion is pending, resolve it first. Then run the uninstall command below and restart DSH.

```bash
dsh plugin --profile web remove dsh-session-deletion
```

With DSH stopped, you can also remove the plugin’s `.dsh-session-deletion` directory under your `DSH_HOME`.

## **6 - Development and Testing**

<span style="margin-left:2em;">&#8203;</span>All source code and tests are written in TypeScript. Builds still use TypeScript 7 via the `@typescript/native` alias, while the `typescript` alias provides the TypeScript 6 compatibility API solely for ESLint, following [Microsoft's side-by-side instructions](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60).

The browser suite uses Chrome and a local rc.5 CLI. On Windows, set `DSH_CLI` to the absolute path of the installed `@deepseek-ai/dsh/lib/bin.js`. Set `CHROME_PATH` if Chrome is installed outside its default location.

```bash
pnpm lint              # ESLint correctness and async checks
pnpm check             # Strict TypeScript type checking for source and tests
pnpm test              # Run unit tests
pnpm test:integration  # Exercise an isolated DSH Web profile in Chrome
pnpm test:release      # Run all four checks
```
