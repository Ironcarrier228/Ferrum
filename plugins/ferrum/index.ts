import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "./src/config.ts";
import { Audit } from "./src/audit.ts";
import { ModeStore, parseModeArgs, isOwnerSender } from "./src/modes.ts";
import { decideLocal, isLocalTool, sessionEligibleForLocal } from "./src/policy.ts";
import * as host from "./src/host.ts";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

export default definePluginEntry({
  id: "ferrum",
  name: "Ferrum",
  description: "Sandbox/local modes, host access only through local_* tools, policy, approvals and audit",
  register(api: any) {
    const cfg = resolveConfig(api.pluginConfig);
    const audit = new Audit(cfg.auditDir);
    const modes = new ModeStore(cfg.idleMinutes * 60_000, cfg.confirmSeconds * 1000, Date.now, (e) => audit.write({ ...e, source: "modes" }));
    // toolCallId -> params JSON, for calls the before_tool_call hook sent to approval. Defense in depth:
    // execute() refuses an approval-class call that did not pass through the hook (e.g. another entry point).
    const gated = new Map<string, string>();
    const calls = new Map<string, number>(); // runId -> tool calls in this turn (only used when a cap is configured)
    const env = { localRoot: cfg.localRoot, exists: (rel: string) => host.existsRel(cfg, rel) };
    audit.write({ ev: "plugin_loaded", localRoot: cfg.localRoot, localRootMount: cfg.localRootMount, idleMinutes: cfg.idleMinutes, maxToolCallsPerTurn: cfg.maxToolCallsPerTurn });

    // ---- the only gate that makes local_* visible: mode === local AND an eligible session
    const visible = (ctx: any) => !!ctx?.sessionKey && sessionEligibleForLocal(ctx.sessionKey).ok && modes.mode(ctx.sessionKey) === "local";

    const reg = (name: string, label: string, description: string, parameters: any, run: (params: any, ctx: any, signal?: AbortSignal) => Promise<string> | string) => {
      api.registerTool((ctx: any) => {
        if (!visible(ctx)) return null;
        return {
          name, label, description, parameters,
          async execute(id: string, params: any, signal?: AbortSignal) {
            // Re-check at execution time: the mode may have expired while an approval was pending.
            if (!visible(ctx)) throw new Error("local mode is not active for this session");
            const d = decideLocal(name, params ?? {}, env);
            if (d.action === "block") throw new Error(d.reason);
            if (d.action === "approve") {
              const g = gated.get(id);
              gated.delete(id);
              if (g === undefined || g !== JSON.stringify(params ?? {})) throw new Error("this action needs owner approval, and none was requested for this call");
            }
            modes.touch(ctx.sessionKey);
            return text(await run(params ?? {}, ctx, signal));
          },
        };
      }, { name });
    };

    const rootNote = `Only inside ${cfg.localRoot} (Windows). Paths may be relative to it.`;
    reg("local_read", "Read Windows file", `Read a text file on the owner's Windows PC (max 1 MB). ${rootNote}`,
      Type.Object({ path: Type.String() }), (p) => host.readFile(cfg, p.path));
    reg("local_list", "List Windows folder", `List a folder on the owner's Windows PC. ${rootNote}`,
      Type.Object({ path: Type.Optional(Type.String()) }), (p) => host.listDir(cfg, p.path));
    reg("local_write", "Write Windows file", `Create a text file on the owner's Windows PC. Overwriting an existing file asks the owner for approval. ${rootNote}`,
      Type.Object({ path: Type.String(), content: Type.String() }), (p) => host.writeFile(cfg, p.path, p.content));
    reg("local_delete", "Delete on Windows", `Delete a file or folder on the owner's Windows PC. Always asks the owner for approval. ${rootNote}`,
      Type.Object({ path: Type.String(), recursive: Type.Optional(Type.Boolean()) }), (p) => host.deletePath(cfg, p.path, p.recursive === true));
    reg("local_exec", "Run on Windows", `Run ONE short PowerShell command (max 400 chars) on the owner's Windows PC, working directory ${cfg.localRoot}. Always asks the owner for approval, who sees the whole command. Timeout ${cfg.execTimeoutSeconds}s.`,
      Type.Object({ command: Type.String() }), async (p, _c, signal) => host.joinOutput(await host.execPowershell(cfg, p.command, signal)));

    // ---- policy
    api.on("before_tool_call", async (event: any, ctx: any) => {
      const key: string = ctx?.sessionKey ?? "";
      const tool: string = event.toolName;
      const mode = modes.mode(key);
      const base = { session: key, agent: ctx?.agentId, run: event.runId, callId: event.toolCallId, mode, tool, requester: ctx?.requester };
      const refuse = (reason: string) => { audit.write({ ev: "tool_call", ...base, params: event.params, decision: "block", reason }); return { block: true, blockReason: `Ferrum: ${reason}` }; };

      if (cfg.maxToolCallsPerTurn !== null && event.runId) {
        const n = (calls.get(event.runId) ?? 0) + 1;
        calls.set(event.runId, n);
        if (calls.size > 500) calls.delete(calls.keys().next().value as string);
        if (n > cfg.maxToolCallsPerTurn) return refuse(`tool-call limit per turn reached (${cfg.maxToolCallsPerTurn})`);
      }
      if (!isLocalTool(tool)) { audit.write({ ev: "tool_call", ...base, params: event.params, decision: "pass" }); return; }

      if (mode !== "local") return refuse("local_* tools are only available in local mode (/mode local)");
      const el = sessionEligibleForLocal(key);
      if (!el.ok) return refuse(el.reason);
      const d = decideLocal(tool, event.params ?? {}, env);
      if (d.action === "block") return refuse(d.reason);
      if (d.action === "allow") { audit.write({ ev: "tool_call", ...base, params: event.params, decision: "allow" }); return; }
      audit.write({ ev: "tool_call", ...base, params: event.params, decision: "approval_requested", title: d.title, description: d.description });
      if (event.toolCallId) {
        gated.set(event.toolCallId, JSON.stringify(event.params ?? {}));
        if (gated.size > 200) gated.delete(gated.keys().next().value as string);
      }
      return {
        requireApproval: {
          title: d.title, description: d.description, severity: d.severity,
          allowedDecisions: ["allow-once", "deny"], timeoutMs: cfg.approvalTimeoutSeconds * 1000,
          onResolution: (decision: string) => {
            if (decision !== "allow-once" && decision !== "allow-always" && event.toolCallId) gated.delete(event.toolCallId);
            audit.write({ ev: "approval_resolved", ...base, decision });
          },
        },
      };
    }, { priority: 100 });

    api.on("after_tool_call", async (event: any, ctx: any) => {
      const r = event.result?.content?.map?.((c: any) => c?.text).filter(Boolean).join("\n");
      audit.write({ ev: "tool_result", session: ctx?.sessionKey, run: event.runId, callId: event.toolCallId, tool: event.toolName, ms: event.durationMs, error: event.error, result: r });
    });

    // ---- /mode (handled before the model ever sees the message; owner only)
    api.registerCommand({
      name: "mode",
      description: "Режим работы: sandbox (по умолчанию) или local (доступ к " + cfg.localRoot + ")",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx: any) => {
        const key: string = ctx.sessionKey ?? "";
        if (!isOwnerSender(ctx.config, ctx.channel, ctx.senderId)) {
          audit.write({ ev: "mode_command_refused", session: key, channel: ctx.channel, sender: ctx.senderId, reason: "not an owner" });
          return { text: "Эта команда доступна только владельцу." };
        }
        const a = parseModeArgs(ctx.args);
        const status = () => {
          const m = modes.mode(key);
          return m === "local" ? `Режим: LOCAL (доступ к ${cfg.localRoot}). Вернусь в sandbox через ${Math.ceil(modes.idleLeftMs(key) / 60000)} мин без активности.` : "Режим: SANDBOX (изолированная среда, доступа к вашему ПК нет).";
        };
        switch (a.kind) {
          case "bad": return { text: a.text };
          case "status": return { text: status() };
          case "sandbox": modes.setSandbox(key); return { text: "Режим: SANDBOX." };
          case "local": {
            const el = sessionEligibleForLocal(key);
            if (!el.ok) return { text: `Local недоступен в этой сессии: ${el.reason}.` };
            const code = modes.requestLocal(key);
            return { text: `Включить LOCAL? Агент сможет читать и создавать файлы в ${cfg.localRoot}; удаление, перезапись и запуск команд подтверждаются отдельно.\nЧтобы подтвердить, отправьте: /mode confirm ${code}\nКод действует ${cfg.confirmSeconds} с. Отмена: /mode sandbox` };
          }
          case "confirm": {
            const el = sessionEligibleForLocal(key);
            if (!el.ok) return { text: `Local недоступен в этой сессии: ${el.reason}.` };
            const r = modes.confirmLocal(key, a.code);
            return { text: r.ok ? `Режим: LOCAL до ${cfg.idleMinutes} мин без активности. /mode sandbox вернёт изоляцию сразу.` : `Не включено: ${r.reason}.` };
          }
        }
      },
    });
  },
});
