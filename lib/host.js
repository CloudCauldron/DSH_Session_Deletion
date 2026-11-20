import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { SUPPORTED_DSH, familyOf, listRequests, readJSON, stateDir } from './core.js';
import { DeletionRefused } from './runtime.js';
import { registerCatalogs } from './locale/catalogs.js';
import { describeFailure, LocalizedError } from './locale/errors.js';
class HttpError extends LocalizedError {
    status;
    constructor(status, key, params) {
        super(key, params);
        this.status = status;
    }
}
function send(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
}
async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json') || req.headers['x-dsh-session-deletion'] !== '1')
        throw new HttpError(415, 'error.expectedPluginJson');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
        const value = Buffer.from(chunk);
        bytes += value.length;
        if (bytes > 16384)
            throw new HttpError(413, 'error.requestTooLarge');
        chunks.push(value);
    }
    let data;
    try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new HttpError(400, 'error.invalidJson');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new HttpError(400, 'error.expectedJsonObject');
    return data;
}
export function registerRoutes(ctx, runtime) {
    const home = runtime.home;
    registerCatalogs(ctx.connection.fetch, 'session-deletion');
    const previews = new Map();
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/session-deletion/api', async handler(req, res) {
            try {
                const admission = ctx.connection.admit(req);
                if ('rejection' in admission)
                    throw new HttpError(admission.rejection, 'error.unauthorized');
                if (admission.peer.principal.kind !== 'owner')
                    throw new HttpError(403, 'error.ownerRequired');
                const path = new URL(req.url || '/', 'http://localhost').pathname;
                if (req.method === 'GET' && path === '/session-deletion/api/status') {
                    const [requests, gc, cleanup] = await Promise.all([
                        listRequests(home), readJSON(join(stateDir(home), 'gc.json'), null), readJSON(join(stateDir(home), 'status.json'), null),
                    ]);
                    send(res, 200, { ok: true, mode: 'private-delete-and-gc', version: SUPPORTED_DSH, gcRunning: runtime.gcRunning, deletionRunning: runtime.deletionRunning,
                        archived: runtime.archivedIds, locked: [...runtime.locked],
                        pending: requests.map(r => ({ sessionId: r.sessionId, queuedAt: r.queuedAt })),
                        receipt: runtime.receiptSummary, gc, cleanup });
                    return;
                }
                if (req.method === 'GET' && path === '/session-deletion/api/receipt') {
                    send(res, 200, { ok: true, ...runtime.receipt });
                    return;
                }
                if (req.method === 'GET' && path === '/session-deletion/api/gc-size') {
                    send(res, 200, { ok: true, bytes: await runtime.garbageSize() });
                    return;
                }
                if (req.method !== 'POST')
                    throw new HttpError(405, 'error.methodNotAllowed');
                const data = await body(req);
                if (path === '/session-deletion/api/gc') {
                    if (data.confirmation !== 'COLLECT_ORPHAN_ATTACHMENTS')
                        throw new HttpError(400, 'error.confirmGc');
                    send(res, 200, { ok: true, ...await runtime.gc() });
                    return;
                }
                if (typeof data.sessionId !== 'string' || !data.sessionId || data.sessionId.length > 1024)
                    throw new HttpError(400, 'error.invalidSessionId');
                const id = data.sessionId;
                if (path === '/session-deletion/api/delete') {
                    if (data.confirmation !== 'DELETE_SESSION')
                        throw new HttpError(400, 'error.confirmDeletion');
                    const preview = previews.get(id);
                    const token = typeof data.token === 'string' ? data.token : '';
                    if (!preview || preview.expires < Date.now() || Buffer.byteLength(token) !== Buffer.byteLength(preview.token)
                        || !timingSafeEqual(Buffer.from(token), Buffer.from(preview.token)))
                        throw new HttpError(409, 'error.previewExpired');
                    previews.delete(id);
                    // remove() reserves maintenance synchronously, before its authoritative async reads.
                    send(res, 200, { ok: true, ...await runtime.remove(id, preview.createdAt, preview.ids) });
                    return;
                }
                const result = await (async () => {
                    const headers = await runtime.headers();
                    const header = headers.get(id);
                    if (!header)
                        throw new HttpError(404, 'error.sessionMissing');
                    if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0)
                        throw new HttpError(400, 'error.mainSessionRequired');
                    const ids = familyOf(headers, id);
                    if (path === '/session-deletion/api/preview') {
                        const token = randomBytes(24).toString('hex');
                        if (previews.size >= 256)
                            previews.delete(previews.keys().next().value);
                        previews.set(id, { token, expires: Date.now() + 120000, createdAt: header.createdAt, ids });
                        return { ok: true, sessionId: id, count: ids.length, token, archived: runtime.archivedIds.includes(id) };
                    }
                    throw new HttpError(404, 'error.unknownRoute');
                })();
                send(res, 200, result);
            }
            catch (e) {
                send(res, e instanceof HttpError || e instanceof DeletionRefused ? e.status : 500, { ok: false, ...describeFailure(e) });
            }
        } }), 'session-deletion HTTP routes');
}
