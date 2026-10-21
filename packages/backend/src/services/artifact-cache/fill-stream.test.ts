import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { FillStream, type FillOutcome } from './fill-stream.js';

function fakeHandle(failAfter = Infinity): { handle: FileHandle; written: Buffer[] } {
  const written: Buffer[] = [];
  let calls = 0;
  const handle = {
    async write(chunk: Buffer) {
      calls += 1;
      if (calls > failAfter) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      written.push(Buffer.from(chunk));
      return { bytesWritten: chunk.length, buffer: chunk };
    },
  } as unknown as FileHandle;
  return { handle, written };
}

async function run(stream: FillStream, chunks: Buffer[]): Promise<{ out: Buffer; outcome: FillOutcome }> {
  const settled = new Promise<FillOutcome>((resolve) => (stream.onSettled = resolve));
  const out: Buffer[] = [];
  const sink = async (source: AsyncIterable<Buffer>) => {
    for await (const chunk of source) out.push(chunk);
  };
  await pipeline(Readable.from(chunks), stream, sink);
  return { out: Buffer.concat(out), outcome: await settled };
}

describe('FillStream', () => {
  const chunks = [Buffer.from('alpha-'), Buffer.from('beta-'), Buffer.from('gamma')];
  const all = Buffer.concat(chunks);

  it('passes every byte to the client and writes the same bytes, hashed and counted', async () => {
    const { handle, written } = fakeHandle();
    const { out, outcome } = await run(new FillStream(handle, 1000), chunks);
    expect(out.equals(all)).toBe(true);
    expect(Buffer.concat(written).equals(all)).toBe(true);
    expect(outcome).toMatchObject({ ended: true, bytes: all.length, writeError: null, tooLarge: false });
    expect(outcome.sha256).toBe(createHash('sha256').update(all).digest('hex'));
  });

  it('a write error stops the file, not the download', async () => {
    const { handle, written } = fakeHandle(1);
    const { out, outcome } = await run(new FillStream(handle, 1000), chunks);
    expect(out.equals(all)).toBe(true);
    expect(written).toHaveLength(1);
    expect((outcome.writeError as NodeJS.ErrnoException).code).toBe('ENOSPC');
  });

  it('a file over the limit stops writing and is marked too large', async () => {
    const { handle, written } = fakeHandle();
    const { out, outcome } = await run(new FillStream(handle, 8), chunks);
    expect(out.equals(all)).toBe(true);
    expect(Buffer.concat(written).toString()).toBe('alpha-');
    expect(outcome.tooLarge).toBe(true);
  });

  it('settles as not ended when destroyed first, after its last write finished', async () => {
    let finishWrite: () => void = () => undefined;
    const written: Buffer[] = [];
    const handle = {
      write: (chunk: Buffer) =>
        new Promise((resolve) => {
          finishWrite = () => {
            written.push(Buffer.from(chunk));
            resolve({ bytesWritten: chunk.length });
          };
        }),
    } as unknown as FileHandle;
    const stream = new FillStream(handle, 1000);
    const settled = new Promise<FillOutcome>((resolve) => (stream.onSettled = resolve));
    stream.on('data', () => undefined);
    stream.write(Buffer.from('part'));
    stream.destroy();
    let reported = false;
    void settled.then(() => (reported = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reported, 'waits for the write in flight').toBe(false);
    finishWrite();
    const outcome = await settled;
    expect(outcome).toMatchObject({ ended: false, bytes: 4 });
    expect(outcome.sha256).toBe(createHash('sha256').update('part').digest('hex'));
    expect(written).toHaveLength(1);
  });
});
