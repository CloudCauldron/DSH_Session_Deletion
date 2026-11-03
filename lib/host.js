import { join, resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { listRequests, readJSON, stateDir } from './core.js';
import { DeletionRefused } from './runtime.js';
export const name = 'session-deletion';
export const inject = ['sessionDeletionGate', 'sessionDeletionRuntime', 'webServer', 'connection', 'sessionPersistence', 'sessionController', 'schedule'];
class HttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
function send(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
}
async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json') || req.headers['x-dsh-session-deletion'] !== '1')
        throw new HttpError(415, 'Expected the plugin JSON request');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
        const value = Buffer.from(chunk);
        bytes += value.length;
        if (bytes > 16384)
            throw new HttpError(413, 'Request too large');
        chunks.push(value);
    }
    let data;
    try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new HttpError(400, 'Invalid JSON');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new HttpError(400, 'Expected a JSON object');
    return data;
}
export async function apply(ctx) {
    const gate = ctx.sessionDeletionGate;
    const runtime = ctx.sessionDeletionRuntime;
    if (ctx.sessionPersistence.name !== 'session-persistence-jsonl' || resolve(ctx.sessionPersistence.root) !== join(gate.home, 'sessions'))
        throw new Error('Session Deletion requires the default JSONL session root');
    const previews = new Map();
    ctx.webServer.register({ kind: 'prefix', path: '/session-deletion/api', async handler(req, res) {
            try {
                const rejection = ctx.connection.requestRejection(req);
                if (rejection)
                    throw new HttpError(rejection, 'Not authorized');
                const admission = ctx.connection.admit(req);
                if ('rejection' in admission)
                    throw new HttpError(admission.rejection, 'Not authorized');
                if (admission.peer.principal.kind !== 'owner')
                    throw new HttpError(403, 'Owner access required');
                const path = new URL(req.url || '/', 'http://localhost').pathname;
                if (req.method === 'GET' && path === '/session-deletion/api/status') {
                    send(res, 200, { ok: true, mode: 'private-delete-and-gc', version: gate.version, guardHealthy: gate.healthy(), gcRunning: runtime.gcRunning, deletionRunning: runtime.deletionRunning,
                        archived: runtime.archivedIds, locked: [...runtime.locked],
                        pending: (await listRequests(gate.home)).map(r => ({ sessionId: r.sessionId, queuedAt: r.queuedAt })),
                        receipt: runtime.receiptSummary,
                        gc: await readJSON(join(stateDir(gate.home), 'gc.json'), null),
                        cleanup: await readJSON(join(stateDir(gate.home), 'status.json'), null) });
                    return;
                }
                if (req.method === 'GET' && path === '/session-deletion/api/receipt') {
                    send(res, 200, { ok: true, ...runtime.receipt });
                    return;
                }
                if (req.method !== 'POST')
                    throw new HttpError(405, 'Method not allowed');
                const data = await body(req);
                if (path === '/session-deletion/api/gc') {
                    if (data.confirmation !== 'COLLECT_ORPHAN_ATTACHMENTS')
                        throw new HttpError(400, '需要明确确认清理残留附件与缓存。');
                    send(res, 200, { ok: true, ...await runtime.gc() });
                    return;
                }
                if (typeof data.sessionId !== 'string' || !data.sessionId || data.sessionId.length > 1024)
                    throw new HttpError(400, 'Invalid session ID');
                const id = data.sessionId;
                if (!gate.healthy())
                    throw new HttpError(503, '恢复监测不可用，请重启 DSH。');
                const result = await (async () => {
                    const headers = await runtime.headers();
                    const header = headers.get(id);
                    if (!header)
                        throw new HttpError(404, '会话不存在或已经删除。');
                    if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0)
                        throw new HttpError(400, '请从主会话入口删除，以包含全部子代理。');
                    const ids = runtime.family(headers, id);
                    if (path === '/session-deletion/api/preview') {
                        const token = randomBytes(24).toString('hex');
                        if (previews.size >= 256)
                            previews.delete(previews.keys().next().value);
                        previews.set(id, { token, expires: Date.now() + 120000, createdAt: header.createdAt, ids });
                        return { ok: true, sessionId: id, count: ids.length, token, archived: runtime.archivedIds.includes(id) };
                    }
                    if (path === '/session-deletion/api/delete') {
                        if (data.confirmation !== 'DELETE_IDLE_SESSION')
                            throw new HttpError(400, '需要明确确认永久删除。');
                        const preview = previews.get(id);
                        const token = typeof data.token === 'string' ? data.token : '';
                        if (!preview || preview.expires < Date.now() || Buffer.byteLength(token) !== Buffer.byteLength(preview.token)
                            || !timingSafeEqual(Buffer.from(token), Buffer.from(preview.token)))
                            throw new HttpError(409, '确认已过期，请重新打开删除对话框。');
                        if (header.createdAt !== preview.createdAt || JSON.stringify(ids) !== JSON.stringify(preview.ids))
                            throw new HttpError(409, '会话或子代理集合已变化，请重新确认。');
                        previews.delete(id);
                        return { ok: true, ...await runtime.remove(id, preview.createdAt, preview.ids) };
                    }
                    throw new HttpError(404, 'Unknown route');
                })();
                send(res, 200, result);
            }
            catch (e) {
                send(res, e instanceof HttpError || e instanceof DeletionRefused ? e.status : 500, { ok: false, error: e instanceof Error ? e.message : 'Operation failed' });
            }
        } });
}
