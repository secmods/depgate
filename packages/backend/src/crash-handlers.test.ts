import { EventEmitter } from 'node:events';
import { CRASH_EXIT_MS, installCrashHandlers } from './crash-handlers.js';

function setup(shutdown = vi.fn()) {
  const proc = Object.assign(new EventEmitter(), { exit: vi.fn() });
  const log = { error: vi.fn(), fatal: vi.fn() };
  installCrashHandlers(log, shutdown, proc);
  return { proc, log, shutdown };
}

describe('crash handlers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs an unhandled rejection and keeps running', () => {
    const { proc, log, shutdown } = setup();
    const reason = new Error('lost write');
    proc.emit('unhandledRejection', reason);
    expect(log.error).toHaveBeenCalledWith({ err: reason }, 'Unhandled promise rejection');
    expect(shutdown).not.toHaveBeenCalled();
    expect(proc.exit).not.toHaveBeenCalled();
  });

  it('shuts down once on an uncaught exception', () => {
    const { proc, log, shutdown } = setup();
    proc.emit('uncaughtException', new Error('boom'));
    proc.emit('uncaughtException', new Error('again'));
    expect(log.fatal).toHaveBeenCalledTimes(2);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith('uncaughtException');
  });

  it('exits if the shutdown does not finish in time', () => {
    vi.useFakeTimers();
    const { proc } = setup();
    proc.emit('uncaughtException', new Error('boom'));
    expect(proc.exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CRASH_EXIT_MS);
    expect(proc.exit).toHaveBeenCalledWith(1);
  });

  it('exits at once if the shutdown itself throws', () => {
    const { proc } = setup(
      vi.fn(() => {
        throw new Error('close failed');
      })
    );
    proc.emit('uncaughtException', new Error('boom'));
    expect(proc.exit).toHaveBeenCalledWith(1);
  });
});
