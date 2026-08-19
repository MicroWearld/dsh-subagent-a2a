# dsh-subagent-a2a

独立的 DeepSeek Harness A2A Client Provider 插件。

让 DSH 的 `subagent` 工具可以委托给远程 A2A agent。

## 特性

- 注册 `ctx.subagents` provider：`a2a`
- 发现远程 AgentCard
- 阻塞式 `SendMessage`
- 将 A2A Task artifact 映射为 `SubagentResult.output`
- 支持取消、超时、错误映射

## 构建

```bash
export DSH_CHECKOUT=/path/to/deepseek-harness
bash scripts/build.sh
```

## Windows 构建

```powershell
$env:DSH_CHECKOUT = "D:\workspace\dsh\deepseek-harness"
powershell -ExecutionPolicy Bypass -File scripts/build.ps1
```

或：

```powershell
npm run build:ps1
```

## 安装

使用 DSH 官方插件装配命令：

```powershell
cd D:\workspace\dsh
dsh plugin --profile desktop add .\dsh-subagent-a2a\
```

安装完成后重启 DSH Desktop（或对应 profile 的运行时）使插件加载。

> 说明：`dsh plugin add` 会将该插件写入 profile 的 `dependencies` 与 `bundles`，并按官方装配流程加载 `cordis.patch.yml`。

## 配置示例

```yaml
- id: subagent-a2a
  name: 'dsh-subagent-a2a'
  config:
    providerName: a2a
    url: http://127.0.0.1:4123
    agentCardPath: /.well-known/agent.json
    headers:
      Authorization: Bearer token
    timeoutMs: 120000
```

## 说明

- 本插件不是 `@deepseek-ai` 官方包，使用无 scope 包名 `dsh-subagent-a2a`。
- 只依赖 DSH 官方 `@deepseek-ai/*` 包与 `@a2a-js/sdk`，不依赖其他第三方插件。
- 构建产物 `lib/index.js` 已自包含打包运行时依赖。
