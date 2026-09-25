import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
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
  it("traverses the CLI and TUI static dependency graphs without loading semantic runtime", () => {
    const src = join(process.cwd(), "planner/AnyFusion-Pi/packages/coding-agent/src");
    const pending = [join(src, "cli.ts"), join(src, "modes/metawork-tui/index.ts")];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      expect(file).not.toMatch(/\/(?:agent-session[^/]*|session-manager|auth-storage|model-registry|sdk|main-runtime)\.ts$/u);
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
        const specifier = statement.moduleSpecifier;
        if (!specifier || !ts.isStringLiteral(specifier)) continue;
        const name = specifier.text;
        expect(name, `${file} imports ${name}`).not.toMatch(/pi-ai|pi-agent-core|better-sqlite3/u);
        if (!name.startsWith(".")) continue;
        let target = resolve(dirname(file), name);
        if (target.endsWith(".js")) target = target.slice(0, -3) + ".ts";
        if (existsSync(target) && target.endsWith(".ts")) pending.push(target);
      }
    }
    expect(seen.size).toBeGreaterThan(20);
  });

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
      // ADR-0041：旧简版客户端已删除；只审计仍然存在的 Gateway 客户端边界。
    ];
    for (const file of roots.flatMap(root => root.endsWith(".ts") ? [root] : filesUnder(root))) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/from ["'][^"']*(storage|kernel|execution|account-runtime|conversation-session)[^"']*["']/u);
      expect(source).not.toMatch(/from ["'][^"']*workspace-catalog-store[^"']*["']/u);
    }
  });

  it("keeps the single-TUI client tree free of runtime, model and Host ownership", () => {
    // ADR-0041 / 统一 TUI 设计 §5、§15.1：扫描新客户端入口的传递依赖，
    // 不只检查几个文件的 import 字符串。
    const root = join(
      process.cwd(),
      "planner",
      "AnyFusion-Pi",
      "packages",
      "coding-agent",
      "src",
      "modes",
      "metawork-tui",
    );
    const forbidden = [
      /AgentSessionRuntime/u,
      /AgentSession\b/u,
      /SessionManager/u,
      /ToolDefinition/u,
      /PlannerHostBridge/u,
      /planner-host-bridge/u,
      /better-sqlite3/u,
      /from ["'][^"']*(storage|kernel|executor|account-runtime|conversation-session|tui-bridge)[^"']*["']/u,
      /models\/registry/u,
      /model-registry/u,
      /createBashTool/u,
    ];
    const files = filesUnder(root);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("loads the single TUI entry lazily from the Gateway client branch", () => {
    const main = readFileSync(join(
      process.cwd(),
      "planner",
      "AnyFusion-Pi",
      "packages",
      "coding-agent",
      "src",
      "main.ts",
    ), "utf8");
    // 客户端分支不静态加载 TUI（及运行时）模块图。
    expect(main).not.toMatch(/^import .*metawork-tui/u);
    expect(main).toContain("await import(\"./modes/metawork-tui/index.ts\")");
    expect(main).not.toMatch(/from ["'][^"']*core\/(?:agent-session|session-manager|auth-storage|model-registry)/u);
    expect(main).toContain('await import("./main-runtime.ts")');
  });
});
