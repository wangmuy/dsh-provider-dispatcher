/**
 * Setup script for dispatching web search providers.
 *
 * The provider-dispatcher plugin loads this via `config.setup`.
 * It mounts all child plugins under an isolated `web`/`tools`/`systemPrompt`
 * realm, records every `registerSearchProvider` call they make, and registers
 * a single proxy `WebSearchProvider` on the global `ctx.web` that fans one
 * search out to every recorded child provider.
 */

export default async function setup(ctx, config, helpers) {
  const params = config.params ?? {}
  const children = config.children ?? []

  const recordingWeb = helpers.createRecordingRegistry()
  const recordingTools = helpers.createRecordingRegistry()

  // Save the global web reference BEFORE isolate, because isolate('web') can
  // affect ctx.web through Cordis trace proxying.
  const globalWeb = ctx.web

  let mounted
  const ensureMounted = () => {
    mounted ??= (async () => {
      const privateCtx = ctx.isolate('web').isolate('tools').isolate('systemPrompt')
      privateCtx.provide('web', recordingWeb)
      privateCtx.provide('tools', recordingTools)
      await helpers.mountChildren(privateCtx, children)
      // After children have loaded, apply tool remap: captured tools can be
      // re-registered under new names into the global tools registry.
      helpers.applyToolRemap(ctx, recordingTools, params.toolRemap)
      return { recordingWeb, recordingTools }
    })()
    return mounted
  }
  void ensureMounted()

  const providerId = params.providerId ?? 'dispatcher-search'
  const strategy = params.strategy ?? 'parallel'
  const tolerate = params.tolerateFailures ?? true

  globalWeb.registerSearchProvider({
    id: providerId,
    available() {
      return true
    },
    async search(request, signal) {
      const { recordingWeb } = await ensureMounted()
      const providers = recordingWeb.registrations.get('registerSearchProvider') ?? []
      const runOne = async (provider) => {
        try {
          return await provider.search(request, signal)
        } catch {
          if (!tolerate) throw new Error(`provider-dispatcher: child provider "${provider.id}" failed`)
          return undefined
        }
      }
      const usable = providers.filter((p) => p.available?.() !== false)
      let outcomes
      if (strategy === 'parallel') {
        outcomes = (await Promise.allSettled(usable.map(runOne)))
          .map((o) => o.status === 'fulfilled' ? o.value : undefined)
      } else {
        outcomes = []
        for (const provider of usable) {
          const value = await runOne(provider)
          outcomes.push(value)
          if (value !== undefined) break
        }
      }
      const merge = await helpers.loadModuleDefault(params.merge)
      const mergeFn = typeof merge === 'function'
        ? merge
        : (outs) => outs.find((o) => o !== undefined)
      return typeof mergeFn === 'function' && mergeFn.length >= 2
        ? mergeFn(outcomes, request, { tolerateFailures: tolerate })
        : mergeFn(outcomes, request)
    },
  })
}