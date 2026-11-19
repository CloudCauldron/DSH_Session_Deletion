import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection';
import { type Dictionaries } from './shared.ts';
export declare function readDictionaries(directory?: URL): Dictionaries;
export declare function registerCatalogs(routes: HostConnectionFetch, id: string, directory?: URL): () => Promise<void>;
