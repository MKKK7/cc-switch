import { describe, it, expect } from "vitest";
import { providerPresets } from "@/config/claudeProviderPresets";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import { providerNeedsRouting } from "@/utils/providerCapabilities";
import type { Provider } from "@/types";

describe("local adapter provider presets", () => {
  for (const [name, port] of [["Trae 国际版（路由）", "18788"], ["CommandCode CLI / Go（路由）", "18789"]]) {
    it(`${name} uses normal Claude/Codex provider records requiring routing`, () => {
      const claude = providerPresets.find(p => p.name === name)!;
      const codex = codexProviderPresets.find(p => p.name === name)!;
      expect(claude).toBeDefined(); expect(codex).toBeDefined();
      expect(claude.apiFormat).toBe("openai_chat"); expect(codex.apiFormat).toBe("openai_chat");
      expect(codex.config).toContain(`127.0.0.1:${port}/v1`);
      expect(codex.auth.OPENAI_API_KEY).toBe("");
      for (const app of ["claude", "codex"] as const) {
        const provider = { id: "fixture", name, category: "third_party", settingsConfig: app === "claude" ? claude.settingsConfig : { auth: codex.auth, config: codex.config }, meta: { apiFormat: "openai_chat" } } as Provider;
        expect(providerNeedsRouting(app, provider)).toBe(true);
      }
    });
  }
});
