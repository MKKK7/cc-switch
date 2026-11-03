import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type LocalAdapterKind = "trae" | "commandcode";
export function localAdapterKind(
  endpoint: string,
): LocalAdapterKind | undefined {
  try {
    const url = new URL(endpoint);
    if (url.hostname !== "127.0.0.1") return;
    if (url.port === "18788") return "trae";
    if (url.port === "18789") return "commandcode";
  } catch {
    /* ordinary provider */
  }
}
type Settings = { nodePath: string; productPath: string; proxy: string };
export function LocalAdapterAuth({
  kind,
  onLocalKey,
}: {
  kind: LocalAdapterKind;
  onLocalKey: (key: string) => void;
}) {
  const [settings, setSettings] = useState<Settings>({
    nodePath: "node",
    productPath: "",
    proxy: "",
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    invoke<Settings>("local_adapter_settings", { kind })
      .then((value) => {
        if (active) setSettings(value);
      })
      .catch((error) => {
        if (active) setMessage(String(error));
      });
    return () => {
      active = false;
    };
  }, [kind]);
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <p className="text-sm font-medium">
        需要路由模式 · Chat Completions 协议转换
      </p>
      <p className="text-sm text-fg-2">
        {kind === "trae"
          ? "认证：导入本机 Trae 登录态。使用时无需运行 Trae；过期后需重新登录。目前未实现独立网页登录。下方 API Key 是自动填入的本地连接密钥。"
          : "认证：在下方标准 API Key 栏填写 CommandCode 的 user_ API key，可从官网获取。不读取 DSH 配置，不需要安装或运行 DSH / CommandCode。每个供应商可使用不同 key。"}
      </p>
      <details>
        <summary className="cursor-pointer text-sm">本地适配器运行设置</summary>
        <div className="mt-3 space-y-2">
          <label className="block text-sm">
            Node.js 24 路径
            <Input
              value={settings.nodePath}
              onChange={(e) =>
                setSettings({ ...settings, nodePath: e.target.value })
              }
            />
          </label>
          {kind === "trae" && (
            <label className="block text-sm">
              Trae 安装根目录（标准安装可留空）
              <Input
                placeholder="D:\Tools\Trae"
                value={settings.productPath}
                onChange={(e) =>
                  setSettings({ ...settings, productPath: e.target.value })
                }
              />
              <Button type="button" variant="outline" className="mt-2" onClick={async () => {
                try {
                  const selected = await open({ directory: true, multiple: false, title: "选择 Trae 安装根目录" });
                  if (typeof selected === "string") setSettings({ ...settings, productPath: selected });
                } catch (error) { setMessage(String(error)); }
              }}>选择文件夹</Button>
            </label>
          )}
          <label className="block text-sm">
            HTTPS 代理（留空继承环境）
            <Input
              value={settings.proxy}
              placeholder="http://127.0.0.1:7897"
              onChange={(e) =>
                setSettings({ ...settings, proxy: e.target.value })
              }
            />
          </label>
        </div>
      </details>
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMessage("");
          try {
            const result = await invoke<{
              localKey: string | null;
              models: string[];
            }>("local_adapter_prepare", { kind, settings });
            if (result.localKey) onLocalKey(result.localKey);
            setMessage(
              `已连接，目录含 ${result.models.length} 个模型。按常规表单保存后，在供应商列表选择路由模式。适配器随 CC Switch 自动启动。`,
            );
          } catch (error) {
            setMessage(String(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy
          ? "连接中…"
          : kind === "trae"
            ? "导入 Trae 登录态并连接"
            : "连接 CommandCode 适配器"}
      </Button>
      {message && (
        <p role="status" className="text-sm break-words">
          {message}
        </p>
      )}
    </section>
  );
}
