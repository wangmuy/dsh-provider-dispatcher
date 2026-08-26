/**
 * Setup script for dispatching web fetch providers.
 *
 * Mounts all child plugins under an isolated `web` realm, records every
 * `registerFetchProvider` call they make, and registers a single proxy
 * `WebFetchProvider` on the global `ctx.web` that fans one fetch out to
 * every recorded child provider.
 *
 * Strategy semantics:
 * - `parallel` — race all providers, first success wins, the rest are cancelled.
 * - `bail` — try providers in order, first success wins.
 *
 * Usage (cordis.patch.yml):
 *   - id: provider-dispatcher
 *     config:
 *       inject: ['web']
 *       setup: '@dsh/provider-dispatcher/web-fetch-setup'
 *       params:
 *         providerId: dispatcher-fetch
 *         strategy: parallel
 *         tolerateFailures: true
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
      helpers.applyToolRemap(ctx, recordingTools, params.toolRemap)
      return { recordingWeb, recordingTools }
    })()
    return mounted
  }
  void ensureMounted()

  const providerId = params.providerId ?? 'dispatcher-fetch'
  const strategy = params.strategy ?? 'parallel'
  const tolerate = params.tolerateFailures ?? true

  globalWeb.registerFetchProvider({
    id: providerId,
    available() {
      return true
    },
    async fetch(request, signal) {
      const { recordingWeb } = await ensureMounted()
      const providers = recordingWeb.registrations.get('registerFetchProvider') ?? []
      const usable = providers.filter((p) => p.available?.() !== false)

      if (strategy === 'parallel') {
        // Race: every provider runs in parallel, first success wins, others are
        // cancelled. The caller's signal is merged with our own abort controller
        // so the race winner can cancel the rest.
        const race = new AbortController()
        const merged = AbortSignal.any([signal, race.signal].filter(Boolean))

        const runOne = async (provider) => {
          try {
            return await provider.fetch(request, merged)
          } catch {
            return undefined
          }
        }

        const results = await Promise.allSettled(usable.map(runOne))
        race.abort() // cancel any still-running providers

        const success = results.find((r) => r.status === 'fulfilled' && r.value !== undefined)
        if (success) return success.value

        throw new Error('dispatcher-fetch: no child fetch provider succeeded')
      }

      // bail
      for (const provider of usable) {
        try {
          const value = await provider.fetch(request, signal)
          if (value !== undefined) return value
        } catch {
          if (!tolerate) throw new Error(`provider-dispatcher: child fetch provider "${provider.id}" failed`)
        }
      }
      throw new Error('dispatcher-fetch: no child fetch provider succeeded')
    },
  })
}