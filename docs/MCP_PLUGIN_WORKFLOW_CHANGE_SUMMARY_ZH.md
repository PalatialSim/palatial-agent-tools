# MCP + Plugin 工作流修改总结

## 范围

本文档总结 `feat/mcp+plugin` 分支相对 `origin/main` 的修改，重点描述 Palatial MCP 与 Palatial Isaac Sim Plugin 之间新增的标准化交接流程。

## 目标

原 MCP 流程主要支持将 READY 资产下载为本地 ZIP。当目标是 Isaac Sim Plugin 时，认证导出、归档解压和 USD 插入应由 Plugin 负责。如果 MCP 先导出，Plugin 随后再次导入，同一资产可能触发重复导出并重复消耗 export credit。

本次修改明确了职责边界：

- MCP 负责创建资产、保存规范的 `asset_id`、轮询已有任务并写入交接文件。
- Plugin 负责读取交接文件，并复用现有的 `Import existing asset` 流程。
- 面向 Plugin 的导出操作由 Plugin 负责。

## 相对 `origin/main` 的修改

### 交接领域模块

新增 `src/handoff.js`，负责：

- 定义版本化的 `palatial.isaac.handoff/v1` 契约。
- 校验 asset ID、状态、引擎、来源、生成类型和导出元数据。
- 生成 `dashboard_url`、`import_ready` 和标准化资产元数据。
- 将默认路径解析为 `~/.palatial/palatial-handoff.json`。
- Windows 默认路径为 `%USERPROFILE%\\.palatial\\palatial-handoff.json`。
- 支持 `PALATIAL_HANDOFF_PATH` 和显式输出路径。
- 通过临时文件和 rename 操作进行原子写入。
- 对交接目录和文件使用受限权限。

### MCP 工具

在 `src/mcp.js` 中新增 `palatial_write_isaac_handoff`。

该工具接收已有的 `asset_id`，获取最新状态和可用元数据，并写入标准化交接 JSON。仅当资产状态为 `READY` 时，`import_ready` 才会设为 `true`。

该工具不调用 `/media/export`，不下载 ZIP，也不解压归档。MCP 指引会将 Isaac Plugin 导入路由到该工具，而不是 `palatial_download_asset`。

### 客户端集成

更新 `src/client.js`：

- 资产创建后返回 Isaac Plugin 交接指引。
- 资产达到 READY 状态后返回交接指引。
- 对生成的 variant 提供相同的交接指引。
- 新增 `writeIsaacHandoff()`，负责状态查询、元数据映射、契约构建和文件写入。

### CLI 集成

在 `bin/palatial-agent.js` 中新增 `handoff` 命令：

```sh
palatial-agent handoff --asset-id ASSET_ID
palatial-agent handoff --asset-id ASSET_ID --output ./assets/palatial-handoff.json
```

该命令只写入交接契约，不生成导出 ZIP，也不消耗 MCP export credit。

### Agent 指引和文档

更新 MCP instructions 和 README，将 Isaac 工作流定义为：

```text
创建资产 -> 保存 asset_id -> 轮询已有任务 -> 写入交接文件 -> Plugin 导入
```

新增：

- `docs/isaac-handoff.md`：权威交接契约。
- `docs/PLUGIN_SIDE_PROMPT.md`：Plugin 实现要求。
- `skills/palatial-isaac-handoff.md`：Agent 路由指引。
- `skills/palatial-asset-recovery.md`：失败处理和恢复指引。

当用户明确要求本地导出而不是 Plugin 导入时，原有本地 ZIP 下载流程仍然保留。

### 测试

新增 `test/handoff.test.js`，并扩展 `test/mcp.test.js`，覆盖契约校验、READY 和非 READY 状态、viewer URL 生成、元数据标准化、路径解析、原子写入、不调用导出接口的保证，以及 MCP 工具注册。

## 交接契约

```json
{
  "schema": "palatial.isaac.handoff/v1",
  "asset_id": "asset-example",
  "status": "READY",
  "import_ready": true,
  "dashboard_url": "https://dashboard.palatial.cloud/viewer/asset-example",
  "name": "Storage bin",
  "source": "text",
  "generation_type": "texttosim",
  "engine": ["isaac_sim"],
  "workspace_id": null,
  "export": {
    "owner": "plugin",
    "mcp_should_download": false
  },
  "written_at": "2026-09-21T08:00:00.000Z",
  "client": {
    "name": "@palatial/agent-tools",
    "version": "0.1.0"
  }
}
```

契约规则：

- `schema` 必须为 `palatial.isaac.handoff/v1`。
- `asset_id` 是规范的资产标识。
- 只有当 `status` 为 `READY` 时，`import_ready` 才能为 `true`。
- `export.owner` 固定为 `plugin`。
- `export.mcp_should_download` 固定为 `false`。
- 非 READY 的交接文件可以保留状态，但不得触发自动导入或创建替代任务。
- 交接文件不得包含 API key、签名导出 URL 或其他凭据。

## 端到端工作流

1. Agent 创建包含 `isaac_sim` 的资产。
2. MCP 保存返回的 `asset_id`。
3. MCP 轮询已有资产，不创建替代任务。
4. 资产达到 READY 后，MCP 写入交接 JSON。
5. Plugin 自动发现默认文件，或通过现有导入控件接收该文件。
6. Plugin 校验契约并调用 `import_existing_asset(asset_id)`。
7. Plugin 完成一次认证导出、解压和 USD 插入。

在该流程中，MCP 不修改 Isaac Stage，也不负责解压归档文件。

## 运维收益

- 避免重复导出和重复扣费。
- 明确编排职责与场景导入职责的边界。
- 在不同工具之间保留资产身份和处理状态。
- 通过版本化本地契约支持确定性自动化。
- 保留现有 Plugin 导入路径和凭据管理方式。
- 对非 Plugin 场景继续支持普通本地 ZIP 下载。

## 验证状态

- CLI 和交接模块的 JavaScript 语法检查通过。
- 自动化测试通过 68/69。
- 唯一失败项是 `test/guide.test.js` 中既有的 Windows 符号链接权限测试；由于当前测试环境不允许创建符号链接，该测试返回 `EPERM`。
- 新增的 handoff 和 MCP 测试全部通过。
