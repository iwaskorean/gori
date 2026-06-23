/** Type guard for Node's fs/syscall errors, which carry a string `code`. */
export const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === "object" && error !== null && "code" in error;
