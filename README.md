# @dsh/provider-dispatcher

A generic provider dispatcher for DeepSeek Harness that lets **multiple child
plugins work together behind one capability**. Each child is an ordinary DSH
plugin — the same `inject`/`apply`/`Config` conventions, the same lifecycle —
mounted under a private isolate realm. Every `register*` call a child makes is
captured, and a **setup script** builds a proxy that fans one operation out to
all recorded children.

The framework is **capability-agnostic**: it has no built-in preferences for
web search, web fetch, LSP, subagents, or any other capability. A setup script
decides which services to isolate, which registries to provide, and what proxy
to register.

**How children are combined:**

| Strategy | Meaning |
|---|---|
| `parallel` | Run every child, merge the results (search: dedup sources). |
| `parallel` (fetch) | Race every child, first success wins. |
| `bail` | Try children in order, first success wins. |

Two setup scripts ship beside the framework:
- **`web-search-setup`** — dispatches to `registerSearchProvider` calls.
- **`web-fetch-setup`** — dispatches to `registerFetchProvider` calls (race for
  the fastest result).

## Quick start

Install the bundle into a profile:

```sh
dsh plugin --profile <name> add file:E:/path/to/dsh-plugins/provider-dispatcher
```

> **Important: child plugins that are also bundles must be removed from
> `dsh.profile.bundles`.** If a child (e.g. `@liustack/modsearch`) is listed in
> both `bundles` and `children`, its bundle layer will still register it directly
> into the global `ctx.web`/`ctx.tools` — bypassing the dispatcher proxy. Remove
> it from `bundles` and keep it only in `children`.

The bundled `cordis.patch.yml` inserts a default `provider-dispatcher` row. Override
it or add more rows in the profile's `cordis.patch.yml`:

```yaml
# Re-enable the top-level tool-web (disabled by dsh-web-app).
- id: tool-web
  disabled: false
  config:
    search: true
    fetch: true

# Route the web seam's search and fetch capabilities to the dispatcher proxy.
- id: web
  config:
    searchProvider: dispatcher-search
    fetchProvider: dispatcher-fetch

# Aggregate web search providers.
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

# Aggregate web fetch providers (race curl / pwsh for the fastest result).
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

### How it works

1. The framework waits for `config.inject` services (e.g. `['web']`).
2. It loads the module at `config.setup` and calls `setup(ctx, config, helpers)`.
3. The setup script owns everything: it isolates services, creates recording
   registries, mounts children, and registers a proxy provider on the global
   `ctx.web`.
4. At execution time the proxy fans one call out to every recorded child
   provider and merges the results.

## Configuration

The plugin accepts these top-level fields:

| Key | Required | Meaning |
|---|---|---|
| `inject` | yes | Services to inject before the setup runs (e.g. `['web']`). |
| `setup` | yes | Module specifier of a default-exported `setup(ctx, config, helpers)` function. |
| `children` | no | Array of `{ name, config }` — child plugins to mount. `name` is a module specifier resolved by `import()` (absolute path, relative path, or bare package name). |
| `params` | no | Passed verbatim to the setup script. The setup script's contract defines the shape. |

If `inject` or `setup` is missing the plugin fails at load with a schema error.

## Config fields carried by `params` (web-search-setup)

The bundled `web-search-setup.js` reads these from `params`:

| Key | Default | Meaning |
|---|---|---|
| `providerId` | `dispatcher-search` | The id the proxy registers under on `ctx.web`. |
| `strategy` | `parallel` | `parallel` (run all, merge all), `bail` (stop at the first non-empty), or `bail` (stop at the first result). |
| `merge` | (first-defined) | Module specifier of a default-exported merge function. |
| `tolerateFailures` | `true` | Skip a thrown child instead of failing the dispatch. |
| `toolRemap` | (none) | Map from original tool name → new name. When a child plugin registers a tool (via `ctx.tools.register`) matching a key, it is re-registered under the new name in the global tools registry. Tools not listed stay shielded. |

## Config fields carried by `params` (web-fetch-setup)

The bundled `web-fetch-setup.js` reads these from `params`:

| Key | Default | Meaning |
|---|---|---|
| `providerId` | `dispatcher-fetch` | The id the proxy registers under on `ctx.web`. |
| `strategy` | `parallel` | `parallel` (race all, first success wins), `bail`/`bail` (try in order, first success wins). |
| `tolerateFailures` | `true` | Skip a thrown child instead of failing the dispatch. |

## Setup script contract

A setup script is a module that default-exports:

```js
export default async function setup(ctx, config, helpers) {
  // ctx     — the Cordis context with `config.inject` services available.
  // config  — the provider-dispatcher's full config (params, children, inject, setup).
  // helpers — { createRecordingRegistry, mountChildren, loadModuleDefault }
}
```

The `setup` function owns isolation, recording registry creation, child
mounting, and proxy registration. The framework only calls it.

### Helpers

- **`createRecordingRegistry()`** — returns a Proxy object whose `register*`
  methods record every call. Access `registry.registrations` (a `Map<String, Array>`)
  to enumerate recorded providers.
- **`mountChildren(ctx, children)`** — imports and mounts each child plugin
  under `ctx`, returning the context.
- **`loadModuleDefault(spec)`** — imports a module and returns its default
  export (or the module itself if there is no default).

## Bundled setup scripts

| Script | What it dispatches |
|---|---|
| `@dsh/provider-dispatcher/web-search-setup` | Web search providers (`registerSearchProvider`). |
| `@dsh/provider-dispatcher/web-fetch-setup` | Web fetch providers (`registerFetchProvider`). |

## Bundled merge functions

| Script | What it merges |
|---|---|
| `@dsh/provider-dispatcher/web-search-merge` | Web search results (dedup sources, cap maxResults). |

The web-fetch setup does not need a dedicated merge function: `parallel` races
for the fastest result, `bail`/`bail` return the first success.

## Child contract

### Search provider children

A child is an ordinary DSH plugin that calls `ctx.web.registerSearchProvider`:

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

The child's `ctx.web` is the recording registry provided by the setup script.
The child never reaches the global `ctx.web` — only the proxy does.

### Fetch provider children

Same pattern, but call `ctx.web.registerFetchProvider` and use the
`web-fetch-setup` script.

### Any other capability

Write a custom setup script that isolates the target service, provides a
recording registry, and registers a proxy that fans the operation out to
recorded children. The `RecordingRegistry` captures any `register*` method.

## Writing a custom setup script

```js
// my-setup.js
export default async function setup(ctx, config, helpers) {
  const params = config.params ?? {}
  const recording = helpers.createRecordingRegistry()

  const globalService = ctx.web   // or ctx.lsp, ctx.subagents, etc.

  // Isolate the service, provide the recording registry, mount children.
  const privateCtx = ctx.isolate('web')
  privateCtx.provide('web', recording)
  await helpers.mountChildren(privateCtx, config.children ?? [])

  // Register the proxy on the global service.
  globalService.registerSearchProvider({
    id: params.providerId ?? 'my-proxy',
    available() { return true },
    async search(request, signal) {
      const providers = recording.registrations.get('registerSearchProvider') ?? []
      const results = await Promise.allSettled(
        providers.map(p => p.search(request, signal))
      )
      // merge results ...
    },
  })
}
```

## File layout

```
src/
├── index.js              # Generic framework (no capability built in)
├── web-search-setup.js   # Setup script: web search dispatch
├── web-search-merge.js   # Merge function: web search (dedup sources, cap maxResults)
└── web-fetch-setup.js    # Setup script: web fetch dispatch (race, bail)
```

## Tests

```sh
pnpm run test
```

Unit tests cover the core logic (`createRecordingRegistry`, `applyToolRemap`)
and child lifecycle (mount, unmount, remount). Tests run independently — no
DeepSeek Harness checkout required.

## Known Limitations

- **`ctx.isolate('web')` + `provide('web', ...)` can affect `ctx.web` through Cordis
  trace proxying.** The bundled setup scripts save `const globalWeb = ctx.web` before
  isolate to work around this. New setup scripts should follow the same pattern.
- **The framework does not ship with any child providers.** Children are external
  plugins that the user configures.