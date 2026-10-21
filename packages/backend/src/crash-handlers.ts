import type { EventEmitter } from 'node:events';

/** Time a crash shutdown gets to drain before the process is killed; under docker's stop_grace_period. */
export const CRASH_EXIT_MS = 10_000;

type CrashLog = {
  error: (obj: unknown, msg: string) => void;
  fatal: (obj: unknown, msg: string) => void;
};

type CrashProcess = Pick<EventEmitter, 'on'> & { exit: (code: number) => void };

/**
 * A rejected promise nobody awaited is logged and the server keeps serving.
 * An uncaught exception leaves the process in an unknown state (locks held, pools half-updated),
 * so it shuts down gracefully and the container restart policy brings it back.
 */
export function installCrashHandlers(log: CrashLog, shutdown: (reason: string) => void, proc: CrashProcess = process): void {
  proc.on('unhandledRejection', (reason: unknown) => {
    log.error({ err: reason }, 'Unhandled promise rejection');
  });

  let crashing = false;
  proc.on('uncaughtException', (err: Error) => {
    log.fatal({ err }, 'Uncaught exception, shutting down');
    if (crashing) return;
    crashing = true;
    setTimeout(() => proc.exit(1), CRASH_EXIT_MS).unref();
    try {
      shutdown('uncaughtException');
    } catch {
      proc.exit(1);
    }
  });
}
