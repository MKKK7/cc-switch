# Trae 国际版直连 MVP

这是 CC Switch fork 内置的 Node 适配器，使用已有 Trae 国际版登录态直接请求云端。
**推理时不需要运行 Trae**。需要本机 Node.js 24，以及曾成功登录的 Trae 国际版。
登录过期后需打开 Trae 重新登录，再退出；本实现不刷新、不覆盖登录凭据。

## 在 CC Switch 中使用

1. 在 Claude Code / Codex 页点击「添加供应商」，选择 **Trae 国际版（路由）**。
2. 认证区域点击「导入 Trae 登录态并连接」。非标准安装位置在运行设置中填写
   `resources/app/product.json`，例如 `D:\Tools\Trae\resources\app\product.json`。
3. 本地连接 key 自动写入标准 API Key 栏；按普通表单设置名称、模型和其他参数后保存。
4. 在供应商列表使用 **路由模式**。适配器提供 Chat Completions，由 CC Switch 转换
   Anthropic / Responses 协议，不能选原生直连模式。

适配器随 CC Switch 自动启动。推理不需要运行 Trae，但当前认证仍依赖本机已有登录态；
尚未实现 Trae 独立网页登录，登录过期需到 Trae 重新登录。不会把该限制伪装为 OAuth。

## 范围

- 仅监听 `127.0.0.1:18788`，要求随机本地 API key；Trae JWT 不进入供应商配置或前端。
- `GET /v1/models` 和 `POST /v1/chat/completions`，支持流式、非流式和工具调用。
- 以实时目录的 `config_name + function` 路由，不使用模型自述验证，不静默回退。
- 首版只开放两个已实测的模型，不将整个上游目录宣称为可用。
- HTTP 200 内的 SSE error 及缺少 done 的截断流均视为失败。
- 调用会消耗账号额度；是否能用取决于登录态、套餐和上游服务。
- 图片、其他模型、token 自动续期、所有采样参数尚未验证。上游封装不保证透传所有 OpenAI 参数。
- 当前磁盘登录路径默认 Windows `%APPDATA%\Trae\User\globalStorage\storage.json`；其他路径可通过 `TRAE_STORAGE_PATH` 环境变量指定。GUI MVP 按 Windows 验证。

## 验证和开发

离线回归：`node --test trae-adapter/server.test.mjs`

真实账号测试（会使用少量额度）：

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:7897'
$env:NODE_USE_ENV_PROXY='1'
$env:TRAE_PRODUCT_PATH='D:\Tools\Trae\resources\app\product.json'
node trae-adapter/verify-live.mjs
node trae-adapter/verify-managed.mjs
```

`verify-live` 检查流式输出、服务端报告的真实模型、GPT / Kimi 工具调用与工具结果回传。
`verify-managed` 检查子进程启动、鉴权模型接口和父进程管道关闭后的退出。
不会保存 JWT 或原始聊天日志。不要提交自己的 key 或运行配置。

协议模块来自 [anghunk/trae-proxy](https://github.com/anghunk/trae-proxy)，
固定版本和本地修正见 [vendor/UPSTREAM.md](vendor/UPSTREAM.md)，保留原 MIT 许可。
