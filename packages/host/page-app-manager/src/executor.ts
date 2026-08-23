/**
 * Profile-local pnpm execution: one thin, injectable wrapper around execa so
 * transactions can run, fake, cancel, and diagnose pnpm without ever
 * concatenating user input into a shell command. Arguments travel as an
 * array; on Windows execa resolves `pnpm` to `pnpm.cmd` itself (the test pins
 * the array-call shape, never a joined string).
 * @module @deepseek-ai/dsh-page-app-manager/executor
 */

/** One finished pnpm command's captured outcome (bounded capture). */
export interface PackageCommandResult {
  /** Process exit code (non-zero = failure; the manager maps codes itself). */
  readonly exitCode: number
  /** Captured stdout (bounded). */
  readonly stdout: string
  /** Captured stderr (bounded). */
  readonly stderr: string
}

/** The pnpm-execution seam transactions consume (fakeable in tests). */
export interface PageAppPackageExecutor {
  /**
   * Run one pnpm command in `cwd`.
   * @param args - exact argument list (never a shell string).
   * @param options - working directory and cancellation signal.
   * @returns the captured result; a spawn failure is returned as a result
   * with a non-zero exit code, never thrown (except an AbortError).
   */
  run(args: readonly string[], options: { cwd: string; signal: AbortSignal }): Promise<PackageCommandResult>
}

/** Error thrown when the caller's AbortSignal fired mid-command. */
export class PageAppCommandAbortedError extends Error {
  constructor() {
    super('page-app: pnpm command aborted')
  }
}

/** Structural execa result surface the executor reads (execa v10 shape; exitCode optional). */
interface ExecaResult {
  exitCode?: number | null
  stdout: string
  stderr: string
}

/** execa-style spawn function signature the executor accepts (injectable). */
export type PnpmSpawn = (
  file: string,
  args: readonly string[],
  options: { cwd: string; cancelSignal: AbortSignal; reject: false },
) => Promise<ExecaResult>

/**
 * Build the production pnpm executor. Windows `.cmd` resolution is execa's
 * own PATH walk — the manager never builds a shell command.
 * @param spawn - injectable execa binding (defaults to execa with reject:false).
 * @returns the executor.
 */
export function createPnpmExecutor(spawn?: PnpmSpawn): PageAppPackageExecutor {
  const exec: PnpmSpawn = spawn ?? (async (file, args, options) => {
    const { execa } = await import('execa')
    const result = await execa(file, args, options)
    return result
  })
  return {
    async run(args, options) {
      try {
        // execa v10 renamed the cancellation option from `signal` to
        // `cancelSignal`; the manager's seam keeps the AbortSignal name and
        // must not leak the old key to execa.
        const result = await exec('pnpm', [...args], { cwd: options.cwd, cancelSignal: options.signal, reject: false })
        return {
          exitCode: result.exitCode ?? 0,
          stdout: result.stdout.slice(0, 64_000),
          stderr: result.stderr.slice(0, 64_000),
        }
      } catch (error) {
        if ((error as { name?: string } | null)?.name === 'AbortError') {
          throw new PageAppCommandAbortedError()
        }
        // A spawn failure (missing binary, permission) is a failed command.
        return { exitCode: 1, stdout: '', stderr: String(error) }
      }
    },
  }
}
