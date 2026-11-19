/** Browser bundle in DSH's module-loader format; React comes from the host. */
type ReactAPI = typeof import('react');
type ElementNode = import('react').ReactNode;
type ClientMessage = import('./locale.js').LocalizedMessage;
interface DeletionClientContext {
    fiber: {
        uid: number | null;
    };
    locale: {
        register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void;
        bind(namespace: string): (key: string, params?: Record<string, unknown>) => string;
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
    effect(callback: () => () => void, label: string): unknown;
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
interface Window {
    __ModuleLoader__: {
        load(module: {
            id: string;
            factory(require: (name: string) => unknown): unknown;
        }): void;
    };
}
interface PendingDeletion {
    sessionId: string;
    queuedAt: string;
}
interface GcResult {
    total: number;
}
interface GcDialog {
    busy?: boolean;
    error?: Error;
}
interface DeletionReceipt {
    revision: string;
    deletedIdHashes: string[];
}
interface DeletionStatus {
    gcRunning?: boolean;
    deletionRunning?: boolean;
    pending: PendingDeletion[];
    locked: string[];
    archived: string[];
    guardHealthy: boolean;
    receipt: {
        revision: string;
        count: number;
    };
}
interface DeletionPreview {
    count: number;
    token: string;
    archived: boolean;
}
interface DeletionDialog {
    id: string;
    title: string;
    preview?: DeletionPreview;
    busy?: boolean;
    error?: Error;
}
