import type { IncomingMessage } from 'node:http';
import type { WebServer } from '@deepseek-ai/dsh-host-webserver';
import { type DeletionRuntime } from './runtime.js';
import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection';
export interface HostContext {
    effect(register: () => () => void, label: string): unknown;
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
export declare function registerRoutes(ctx: HostContext, runtime: DeletionRuntime): void;
