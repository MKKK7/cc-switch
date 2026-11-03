# CommandCode in CC Switch

在 Claude Code 或 Codex 页点击「添加供应商」，选择 **CommandCode CLI / Go（路由）**。
在标准 API Key 栏填写官网取得的 `user_` key。不会读取 DSH 的凭据文件，不需要安装
或运行 DSH / CommandCode。名称、模型、参数、保存、编辑和切换均使用标准供应商流程。
不同供应商记录可以填写不同账户 key。

认证区域点击「连接 CommandCode 适配器」，然后按普通流程保存供应商。需要 Node 24，
自定义 Node 路径及网络代理在折叠的运行设置内。成功连接后随 CC Switch 自动启动。
使用时选择 **路由** 模式：适配器提供 Chat Completions，CC Switch 转换 Claude Messages /
Codex Responses；不能用原生直连模式访问这条适配通道。

旧实验版本添加的 CommandCode 记录存的是随机本地 key：请编辑为真实 CommandCode
API key，或使用新预设重新添加。上游内置的「Command Code」预设仍然是官方 Provider API，
与本 CLI / Go 通道不同。

## 接口与范围

- 本地仅监听 `127.0.0.1:18789`，使用该供应商填写的 CommandCode API key 鉴权；Trae 使用独立的 18788。
- 上游使用 DSH 插件同类的 `/alpha/generate` CLI 通道；没有把 Provider API
  的套餐拒绝伪装成成功，也不在失败时切到其他模型。
- 模型目录来自实时 `/provider/v1/models`。2026-11-03 返回 95 项，**目录不等于
  当前套餐权限**，未实测所有模型；套餐限制、额度或失效凭据仍会返回错误。
- 精确传递模型 ID，无 Claude/GPT 到廉价模型的隐式映射。
- 支持 OpenAI Chat Completions 流式和非流式、工具调用与结果回传。
- 流内 error、缺少 finish 的截断流均为失败。保留 tool ID，合并增量及最终快照，
  防止一条工具调用被当成两条。
- 不含账户轮换、登录、刷新凭据、额度展示、网页搜索或图片验证；采用已安装 DSH
  插件 0.15.4 对应的 CLI 版本头 1.88.0。上游协议变化时可能需要更新。

## 验证

离线：`node --test commandcode-adapter/client.test.mjs trae-adapter/server.test.mjs`

真实账号测试（消耗少量套餐额度）：

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:7897'
$env:NODE_USE_ENV_PROXY='1'
# 先显式设置 COMMANDCODE_API_KEY（不在日志中输出）
node commandcode-adapter/verify-live.mjs deepseek/deepseek-v4.1-flash moonshotai/Kimi-K3
```

这两个模型已通过流式回答、一次工具调用及工具结果回传。验证模型字段和请求路由，
不会把模型的自我介绍作为真实型号证明。

协议转换复用 [commandcode-api-proxy 0.4.1](https://github.com/thaolaptrinh/commandcode-api-proxy)
的 MIT 模块，许可和来源在 `vendor/`。打包脚本 `scripts/build-trae-portable.ps1`
现同时包含 Trae 与 CommandCode，输出目录仍为 `release/providers-portable`。

认证变更后验证：离线测试覆盖每请求使用独立账户 key；本轮未重新使用 DSH 凭据做云端测试。
