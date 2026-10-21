import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { Transform, type TransformCallback } from 'node:stream';

export type FillOutcome = {
  /** The upstream body ended normally. False when either side stopped first, which can be after the last byte. */
  ended: boolean;
  bytes: number;
  sha256: string;
  writeError: unknown;
  tooLarge: boolean;
};

/**
 * Passes the upstream body to the client and writes the same bytes to a temp file, hashing and counting
 * them on the way (W1). A chunk is handed to the client before its disk write; the next chunk waits for
 * that write, so at most one chunk is held for the file. A write error or a file over the limit stops the
 * file, never the download. The outcome is reported once the last write has finished.
 */
export class FillStream extends Transform {
  bytes = 0;
  onSettled?: (outcome: FillOutcome) => void;
  private readonly hash = createHash('sha256');
  private writeError: unknown = null;
  private tooLarge = false;
  private settled = false;
  private lastWrite: Promise<void> = Promise.resolve();

  constructor(
    private readonly handle: FileHandle,
    private readonly maxBytes: number
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.push(chunk);
    this.bytes += chunk.length;
    if (this.writeError || this.tooLarge) return callback();
    if (this.bytes > this.maxBytes) {
      this.tooLarge = true;
      return callback();
    }
    this.hash.update(chunk);
    this.lastWrite = this.handle.write(chunk).then(
      () => undefined,
      (err: unknown) => {
        this.writeError = err;
      }
    );
    void this.lastWrite.then(() => callback());
  }

  override _flush(callback: TransformCallback): void {
    this.settle(true);
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.settle(false);
    callback(error);
  }

  private settle(ended: boolean): void {
    if (this.settled) return;
    this.settled = true;
    void this.lastWrite.then(() =>
      this.onSettled?.({
        ended,
        bytes: this.bytes,
        sha256: this.hash.digest('hex'),
        writeError: this.writeError,
        tooLarge: this.tooLarge,
      })
    );
  }
}
