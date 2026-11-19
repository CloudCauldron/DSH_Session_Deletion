import { type LocaleClientContext } from './locale/client.js';
import type { LocalizedProps } from './locale/shared.js';
export interface DeletionClientContext extends LocaleClientContext {
    locale: LocaleClientContext['locale'] & {
        bind(namespace: string): LocalizedProps['t'];
        getSnapshot(): {
            active: string;
            revision: number;
        };
        subscribe(listener: () => void): () => void;
    };
    slots: {
        inject(name: string, callback: () => unknown): unknown;
        register(options: {
            name: string;
            id: string;
            order: number;
            locale: string;
            inject?: () => object;
        }, component: unknown): unknown;
    };
    contextMenus: {
        register(options: {
            id: string;
            target: 'session';
            order: number;
            observe(): {
                getSnapshot(): unknown;
                subscribe(callback: () => void): () => void;
            }[];
            resolve(target: {
                sessionId: string;
                displayTitle: string;
            }): {
                id: string;
                label: string;
                disabled: boolean;
                danger: boolean;
                separatorBefore: boolean;
                afterContent: boolean;
                icon: {
                    key: string;
                };
                run(): void;
            }[];
        }): () => void;
    };
    sessions: {
        list: {
            getSnapshot(): {
                byId: Record<string, {
                    id: string;
                    running: boolean;
                    retainedBy: Record<string, number>;
                }>;
            };
            subscribe(callback: () => void): () => void;
        };
    };
    uiWorkspace: {
        startSession(): void;
    };
}
declare global {
    interface Window {
        __ModuleLoader__: {
            load(module: {
                id: string;
                factory(require: (name: string) => unknown): unknown;
            }): void;
        };
    }
}
export interface PendingDeletion {
    sessionId: string;
    queuedAt: string;
}
export interface DeletionReceipt {
    revision: string;
    deletedIdHashes: string[];
}
export interface DeletionPreview {
    count: number;
    token: string;
    archived: boolean;
}
