type Level = "info" | "warn" | "error";
const colors: Record<Level, string> = { info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" };
export const logger = {
  info: (m: string, ...a: unknown[]) => console.log(colors.info, `[INFO] ${m}`, ...a, "\x1b[0m"),
  warn: (m: string, ...a: unknown[]) => console.warn(colors.warn, `[WARN] ${m}`, ...a, "\x1b[0m"),
  error: (m: string, ...a: unknown[]) => console.error(colors.error, `[ERR ] ${m}`, ...a, "\x1b[0m"),
};
