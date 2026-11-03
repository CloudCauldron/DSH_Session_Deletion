/** Browser bundle in DSH's module-loader format; React comes from the host. */
type ReactAPI = typeof import('react');
type ElementNode = import('react').ReactNode;
interface DeletionClientContext {
    slots: {
        inject(name: string, callback: () => unknown): unknown;
        register(options: {
            name: string;
            id: string;
            order: number;
            inject?: () => object;
        }, component: unknown): unknown;
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
    error?: string;
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
    error?: string;
}
