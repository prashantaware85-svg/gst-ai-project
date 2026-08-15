import fs from "node:fs";
import path from "node:path";

export function ensureDirs(dirs: string[]) {
  for (const d of dirs) {
    fs.mkdirSync(path.resolve(d), { recursive: true });
  }
}
