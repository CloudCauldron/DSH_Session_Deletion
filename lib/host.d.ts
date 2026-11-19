import type { IncomingMessage } from 'node:http';
import type { WebServer } from '@deepseek-ai/dsh-host-webserver';
import { type DeletionRuntime } from './runtime.js';
import type { Gate } from './gate.js';
import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection';
export interface HostContext {
    effect(register: () => () => void, label: string): unknown;
    sessionDeletionGate: Gate;
    sessionDeletionRuntime: DeletionRuntime;
    sessionPersistence: {
        name: string;
        root: string;
    };
    connection: {
        fetch: HostConnectionFetch;
        admit(request: IncomingMessage): {
            rejection: number;
        } | {
            peer: {
                principal: {
                    kind: string;
                };
            };
        };
    };
    webServer: Pick<WebServer, 'register'>;
}
export declare const name = "session-deletion";
export declare const inject: string[];
export declare function apply(ctx: HostContext): Promise<void>;
