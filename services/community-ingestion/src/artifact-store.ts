import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { sha256 } from './hash.js';

export type StoredArtifact = {
  contentHash: string;
  byteLength: number;
  storagePath: string;
  created: boolean;
};

export interface ArtifactStore {
  put(bytes: Uint8Array): Promise<StoredArtifact>;
  read(contentHash: string): Promise<Uint8Array>;
}

export class FileArtifactStore implements ArtifactStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(contentHash: string): string {
    if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error('Invalid artifact content hash');
    return join(this.root, contentHash.slice(0, 2), `${contentHash}.bin`);
  }

  async put(bytes: Uint8Array): Promise<StoredArtifact> {
    const contentHash = sha256(bytes);
    const storagePath = this.pathFor(contentHash);
    await mkdir(dirname(storagePath), { recursive: true });
    let created = true;
    try {
      await writeFile(storagePath, bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      created = false;
    }
    return { contentHash, byteLength: bytes.byteLength, storagePath, created };
  }

  async read(contentHash: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.pathFor(contentHash)));
  }
}
