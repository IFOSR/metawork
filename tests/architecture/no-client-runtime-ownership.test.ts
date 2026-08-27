import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function filesUnder(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) result.push(...filesUnder(path));
    else if (path.endsWith(".ts") || path.endsWith(".tsx")) result.push(path);
  }
  return result;
}

describe("independent client ownership boundary", () => {
  it("keeps root client launchers free of Runtime, storage, and Server shutdown ownership", () => {
    const files = filesUnder(join(process.cwd(), "src", "client"));
    const forbidden = [
      /AccountRuntime/u,
      /ConversationSession/u,
      /RuntimeRegistry/u,
      /PlannerProcessSupervisor/u,
      /ControlKernel/u,
      /FileWorkspaceCatalogStore/u,
      /file-workspace-catalog-store/u,
      /better-sqlite3/u,
      /\.shutdown\(/u,
      /accountPaths\.(database|secrets)/u,
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("keeps the vendored TUI on the Gateway transport boundary", () => {
    const roots = [
      join(
        process.cwd(),
        "planner",
        "AnyFusion-Pi",
        "packages",
        "coding-agent",
        "src",
        "anyfusion",
      ),
      ...[
        "anyfusion-client-mode.ts",
        "metawork-client-model.ts",
        "metawork-client-reducer.ts",
        "metawork-client-view.ts",
      ].map(file => join(
        process.cwd(),
        "planner",
        "AnyFusion-Pi",
        "packages",
        "coding-agent",
        "src",
        "modes",
        "interactive",
        file,
      )),
    ];
    for (const file of roots.flatMap(root => root.endsWith(".ts") ? [root] : filesUnder(root))) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/from ["'][^"']*(storage|kernel|execution|account-runtime|conversation-session)[^"']*["']/u);
      expect(source).not.toMatch(/from ["'][^"']*workspace-catalog-store[^"']*["']/u);
    }
  });
});
