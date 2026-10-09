import { spawn } from "node:child_process";

export function login(serverUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const accessUrl = new URL("/api/vaults", serverUrl).toString();
    const child = spawn("cloudflared", ["access", "login", accessUrl], { stdio: "inherit" });
    child.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("cloudflared is required. Install it, then run this command again."));
        return;
      }
      reject(error);
    });
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`cloudflared access login exited with status ${code ?? "unknown"}`));
      }
    });
  });
}
