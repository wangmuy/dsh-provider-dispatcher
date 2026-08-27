# @dsh/provider-dispatcher

一个用于 DeepSeek Harness 的通用 provider 分发代理。它在私有 isolate 作用域中挂载子插件,捕获子插件发出的每一个 `register*` 调用,然后让用户提供的 **setup 脚本**构建一个代理 provider,把一次操作分发给所有被记录的子 provider。

框架本身**与具体能力无关**:它不内置对 web 搜索、web 抓取、LSP、子代理或任何其他能力的偏好。由 setup 脚本决定要隔离哪些 service、提供哪些 registry、注册什么样的代理。

框架附带两个 setup 脚本:
- **`web-search-setup`** — 分发 `registerSearchProvider` 调用。
- **`web-fetch-setup`** — 分发 `registerFetchProvider` 调用(竞速取最快结果)。

## 快速上手

把 bundle 安装进某个 profile:

```sh
dsh plugin --profile <name> add file:E:/path/to/dsh-plugins/provider-dispatcher
```

> **重要:同时是 bundle 的子插件必须从 `dsh.profile.bundles` 中移除。** 如果子插件(如 `@liustack/modsearch`)同时出现在 `bundles` 和 `children` 中,其 bundle 层仍会直接注册进全局 `ctx.web`/`ctx.tools`,绕过分发代理。请将其从 `bundles` 中移除,只保留在 `children` 中。

内置的 `cordis.patch.yml` 会 insert 一个默认的 `provider-dispatcher` 行。在 profile 的 `cordis.patch.yml` 中覆盖或增加更多行:

```yaml
# 重新启用顶层 tool-web(dsh-web-app 默认禁用了它)。
- id: tool-web
  disabled: false
  config:
    search: true
    fetch: true

# 把 web seam 的搜索和抓取能力路由到分发代理。
- id: web
  config:
    searchProvider: dispatcher-search
    fetchProvider: dispatcher-fetch

# 分发 web 搜索 provider。
- id: provider-dispatcher
  config:
    inject: ['web']
    setup: '@dsh/provider-dispatcher/web-search-setup'
    params:
      providerId: dispatcher-search
      strategy: parallel
      merge: '@dsh/provider-dispatcher/web-search-merge'
      tolerateFailures: true
    children:
      - name: '@liustack/modsearch'
        config:
          xSearch: false
          readPage: false

# 分发 web 抓取 provider(curl 和 pwsh 竞速,取最快的结果)。
- insert:
    - id: dispatcher-fetch
      name: '@dsh/provider-dispatcher'
      config:
        inject: ['web']
        setup: '@dsh/provider-dispatcher/web-fetch-setup'
        params:
          providerId: dispatcher-fetch
          strategy: parallel
          tolerateFailures: true
        children:
          - name: './fetch-curl-child/index.js'
            config:
              proxy: 'http://proxy:80'
              insecure: true
          - name: './fetch-pwsh-child/index.js'
            config:
              proxy: 'http://proxy:80'
              insecure: true
```

### 工作原理

1. 框架等待 `config.inject` 声明的 service(例如 `['web']`)。
2. 加载 `config.setup` 指定的模块,调用 `setup(ctx, config, helpers)`。
3. setup 脚本全权负责:隔离 service、创建 recording registry、挂载子插件,并在全局 `ctx.web` 上注册代理 provider。
4. 执行时,代理把一次调用分发给所有被记录的子 provider,再合并结果。

## 配置

插件接受以下顶层字段:

| 字段 | 必填 | 含义 |
|---|---|---|
| `inject` | 是 | setup 运行前要注入的 service(例如 `['web']`)。 |
| `setup` | 是 | 默认导出 `setup(ctx, config, helpers)` 函数的模块路径。 |
| `children` | 否 | `{ name, config }` 数组 — 要挂载的子插件。`name` 是由 `import()` 解析的模块路径(绝对路径、相对路径或裸包名)。 |
| `params` | 否 | 原样传给 setup 脚本。具体结构由 setup 脚本的约定决定。 |

如果缺少 `inject` 或 `setup`,插件会在加载时报 schema 错误。

## `params` 携带的配置字段(web-search-setup)

内置的 `web-search-setup.js` 从 `params` 读取以下字段:

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerId` | `dispatcher-search` | 代理在 `ctx.web` 上注册的 id。 |
| `strategy` | `parallel` | `parallel`(全部运行、合并全部)、`bail`(遇到第一个非空就停),或 `bail`(遇到第一个结果就停)。 |
| `merge` | (首个非空) | 默认导出合并函数的模块路径。 |
| `tolerateFailures` | `true` | 跳过抛错的子 provider,而不是让整个分发失败。 |
| `toolRemap` | (无) | 原始工具名 → 新名称的映射。当子插件通过 `ctx.tools.register` 注册了匹配某个 key 的工具时,该工具会以新名称重新注册到全局工具注册表中。未列出的工具保持屏蔽。 |

## `params` 携带的配置字段(web-fetch-setup)

内置的 `web-fetch-setup.js` 从 `params` 读取以下字段:

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerId` | `dispatcher-fetch` | 代理在 `ctx.web` 上注册的 id。 |
| `strategy` | `parallel` | `parallel`(竞速,第一个成功胜出)、`bail`/`bail`(顺序尝试,第一个成功胜出)。 |
| `tolerateFailures` | `true` | 跳过抛错的子 provider,而不是让整个分发失败。 |

## Setup 脚本约定

setup 脚本是一个默认导出以下函数的模块:

```js
export default async function setup(ctx, config, helpers) {
  // ctx     — Cordis 上下文,`config.inject` 声明的 service 已可用。
  // config  — provider-dispatcher 的完整配置(params、children、inject、setup)。
  // helpers — { createRecordingRegistry, mountChildren, loadModuleDefault }
}
```

`setup` 函数全权负责隔离、recording registry 创建、子插件挂载和代理注册。框架只负责调用它。

### Helpers

- **`createRecordingRegistry()`** — 返回一个 Proxy 对象,其 `register*` 方法会记录每一次调用。通过 `registry.registrations`(一个 `Map<String, Array>`)枚举被记录的 provider。
- **`mountChildren(ctx, children)`** — 在 `ctx` 下导入并挂载每个子插件,返回该上下文。
- **`loadModuleDefault(spec)`** — 导入一个模块,返回其默认导出(若没有默认导出则返回模块本身)。

## 内置的 setup 脚本

| 脚本 | 分发什么 |
|---|---|
| `@dsh/provider-dispatcher/web-search-setup` | Web 搜索 provider(`registerSearchProvider`)。 |
| `@dsh/provider-dispatcher/web-fetch-setup` | Web 抓取 provider(`registerFetchProvider`)。 |

## 内置的 merge 函数

| 脚本 | 合并什么 |
|---|---|
| `@dsh/provider-dispatcher/web-search-merge` | Web 搜索结果(按 URL 去重、按 maxResults 截断)。 |

web-fetch setup 不需要专用的 merge 函数:`parallel` 竞速取最快结果,`bail`/`bail` 返回第一个成功。

## 子插件约定

### 搜索 provider 子插件

子插件就是一个普通的 DSH 插件,调用 `ctx.web.registerSearchProvider`:

```js
export const name = 'my-search-child'
export const inject = ['web']

export function apply(ctx, config) {
  ctx.web.registerSearchProvider({
    id: 'my-engine',
    available() { return true },
    async search(request, signal) {
      return { sources: [...], truncated: false }
    },
  })
}
```

子插件的 `ctx.web` 是 setup 脚本提供的 recording registry。子插件永远不会触碰全局 `ctx.web` — 只有代理会。

### 抓取 provider 子插件

同样的模式,只是调用 `ctx.web.registerFetchProvider`,并使用 `web-fetch-setup` 脚本。

### 其他任意能力

写一个自定义 setup 脚本,隔离目标 service,提供 recording registry,并注册一个把操作分发给所有被记录子 provider 的代理。`RecordingRegistry` 会捕获任何 `register*` 方法。

## 写一个自定义 setup 脚本

```js
// my-setup.js
export default async function setup(ctx, config, helpers) {
  const params = config.params ?? {}
  const recording = helpers.createRecordingRegistry()

  const globalService = ctx.web   // 或 ctx.lsp、ctx.subagents 等

  // 隔离 service,提供 recording registry,挂载子插件。
  const privateCtx = ctx.isolate('web')
  privateCtx.provide('web', recording)
  await helpers.mountChildren(privateCtx, config.children ?? [])

  // 在全局 service 上注册代理。
  globalService.registerSearchProvider({
    id: params.providerId ?? 'my-proxy',
    available() { return true },
    async search(request, signal) {
      const providers = recording.registrations.get('registerSearchProvider') ?? []
      const results = await Promise.allSettled(
        providers.map(p => p.search(request, signal))
      )
      // 合并结果 ...
    },
  })
}
```

## 文件布局

```
src/
├── index.js              # 通用框架(不内置任何能力)
├── web-search-setup.js   # setup 脚本:web 搜索分发
├── web-search-merge.js   # 合并函数:web 搜索(按 URL 去重、按 maxResults 截断)
└── web-fetch-setup.js    # setup 脚本:web 抓取分发(竞速、短路、顺序)
```

## 测试

```sh
pnpm run test
```

单元测试覆盖核心逻辑(`createRecordingRegistry`、`applyToolRemap`)和子插件生命周期(挂载、卸载、重新挂载)。测试独立运行,无需 DeepSeek Harness 仓库环境。

## 已知限制

- **`ctx.isolate('web')` + `provide('web', ...)` 可能通过 Cordis 的 trace proxying 影响 `ctx.web`。** 内置的 setup 脚本在 isolate 之前保存 `const globalWeb = ctx.web` 来规避此问题。新的 setup 脚本应遵循同样的模式。
- **框架本身不附带任何子 provider。** 子 provider 是用户配置的外部插件。