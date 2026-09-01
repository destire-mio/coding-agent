import { join } from "node:path";
import lockfile from "proper-lockfile";

const SESSION_RUN_LOCK_STALE_MS = 5_000;
const SESSION_RUN_LOCK_UPDATE_MS = 1_000;

export class SessionBusyError extends Error {}
export class SessionRunLeaseError extends Error {}

/** Exclusive cross-process ownership of one active Session run. */
export class SessionRunLease {
  readonly #sessionId: string;
  readonly #releaseLock: () => Promise<void>;
  #released = false;

  private constructor(sessionId: string, releaseLock: () => Promise<void>) {
    this.#sessionId = sessionId;
    this.#releaseLock = releaseLock;
  }

  static async acquire(
    sessionId: string,
    sessionDirectory: string,
  ): Promise<SessionRunLease> {
    try {
      const releaseLock = await lockfile.lock(sessionDirectory, {
        lockfilePath: join(sessionDirectory, ".run.lock"),
        realpath: true,
        retries: 0,
        stale: SESSION_RUN_LOCK_STALE_MS,
        update: SESSION_RUN_LOCK_UPDATE_MS,
        onCompromised: (error) => {
          throw new SessionRunLeaseError(
            `The run lock for Session ${sessionId} was compromised: ${error.message}`,
          );
        },
      });
      return new SessionRunLease(sessionId, releaseLock);
    } catch (error) {
      if (hasErrorCode(error, "ELOCKED")) {
        throw new SessionBusyError(
          `Session ${sessionId} is already running in another process.`,
        );
      }
      if (error instanceof SessionRunLeaseError) {
        throw error;
      }
      throw new SessionRunLeaseError(
        `The run lock for Session ${sessionId} could not be acquired.`,
      );
    }
  }

  async release(): Promise<void> {
    if (this.#released) {
      return;
    }
    this.#released = true;
    try {
      await this.#releaseLock();
    } catch {
      throw new SessionRunLeaseError(
        `The run lock for Session ${this.#sessionId} could not be released.`,
      );
    }
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
