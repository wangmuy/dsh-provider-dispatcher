/**
 * A generic provider dispatcher: mounts child plugins under a private isolate
 * realm where every `register*` call they make is recorded, then lets a
 * user-supplied `setup` script build a proxy provider that fans one operation
 * out to all recorded children.
 *
 * The recording registry is a generic object: any method whose name starts
 * with `register` is captured, storing its arguments under that method name.
 * This dispatches ANY capability whose providers follow the "call
 * `ctx.<service>.registerProvider(obj)` / `registerXxxProvider(obj)` to
 * contribute" convention — web search, web fetch, lsp, subagents, skills, etc.
 *
 * Plain ESM JavaScript so a published dsh can load it from node_modules.
 *
 * @module @dsh/provider-dispatcher
 */

import z from '@deepseek-ai/schemastery'

/**
 * A generic recording registry. Returns an object whose `register*` methods
 * record every registration. `registrations` is a Map from method name to an
 * array of the recorded arguments, in registration order.
 */
export function createRecordingRegistry() {
  /** @type {Map<string, Array<unknown>>} */
  const registrations = new Map()

  const registry = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'registrations') return registrations
      if (prop === 'list') {
        return () => {
          /** @type {Record<string, Array<unknown>>} */
          const out = {}
          for (const [key, values] of registrations) out[key] = values
          return out
        }
      }
      if (typeof prop === 'string' && prop.startsWith('register')) {
        return (...args) => {
          const list = registrations.get(prop) ?? []
          list.push(args.length === 1 ? args[0] : args)
          registrations.set(prop, list)
          const length = list.length - 1
          return () => {
            if (list[length] !== undefined) {
              list.splice(length, 1)
            }
          }
        }
      }
      return undefined
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (prop === 'registrations' || prop === 'list' || (typeof prop === 'string' && prop.startsWith('register'))) {
        return { configurable: true, enumerable: true }
      }
      return undefined
    },
    ownKeys(_target) {
      return ['registrations', 'list', ...registrations.keys()]
    },
  })

  return registry
}

export const name = 'provider-dispatcher'
export const inject = []

export const Config = z.object({
  /** Services to inject before the setup runs. Required at apply time; omitted → throws. */
  inject: z.array(z.string()),

  /**
   * Module specifier resolving a script that default-exports
   * `setup(ctx, config, helpers)`. Required at apply time; omitted → throws.
   */
  setup: z.string(),

  /** Child plugins to mount under the private realm. */
  children: z.array(z.object({
    name: z.string().required(),
    config: z.object({}),
  })).default([]),

  /** Passed verbatim to the setup script (its contract defines the shape). */
  params: z.object({}).default({}),
})

/**
 * Mount every child plugin under `ctx`, recording their registrations into
 * the returned recording registry. Returns the list of child fibers.
 */
export async function mountChildren(ctx, children) {
  const fibers = []
  for (const child of children) {
    const mod = await import(child.name)
    const plugin = mod.default ?? mod
    try {
      const fiber = await ctx.plugin(plugin, child.config)
      fibers.push(fiber)
    } catch (error) {
      // Child load failure: log and continue, so one broken child does not
      // block the others or the host dispatcher.
      ctx.logger?.warn(`provider-dispatcher: child "${child.name}" failed to load: ${error.message}`)
    }
  }
  return fibers
}

/** Load a default-exported function module, or undefined when spec is absent. */
async function loadModuleDefault(spec) {
  if (spec === undefined) return undefined
  const mod = await import(spec)
  const fn = mod.default ?? mod
  if (typeof fn !== 'function' && typeof fn !== 'object') {
    throw new Error(`provider-dispatcher: module ${JSON.stringify(spec)} has no usable default export`)
  }
  return fn
}

/**
 * Apply tool remap: for each ToolDefinition captured by the recording tools
 * registry, if `remap` defines a mapping from the original name to a new name,
 * re-register it under the new name in the global tools registry. Tools not
 * listed in `remap` stay shielded (never enter the global registry).
 *
 * Returns a disposer that unregisters every re-mapped tool. The caller owns
 * calling this disposer before re-applying (e.g. when a child reloads), so it
 * can replace rather than duplicate.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - global context
 * @param {*} recordingTools - recording registry with captured tools
 * @param {Record<string, string> | undefined} remap - original name → new name
 * @returns {() => void} disposer that unregisters all re-mapped tools
 */
export function applyToolRemap(ctx, recordingTools, remap) {
  const disposers = []
  if (!remap || typeof remap !== 'object') return () => {}
  const captured = recordingTools.registrations.get('register')
  if (!captured || captured.length === 0) return () => {}

  const globalTools = ctx.get('tools')
  if (!globalTools) return () => {}

  for (const toolDef of captured) {
    const newName = remap[toolDef.name]
    if (newName && newName !== toolDef.name) {
      const dispose = globalTools.register({ ...toolDef, name: newName })
      disposers.push(dispose)
    }
  }

  return () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* best effort */ }
    }
  }
}

export function apply(ctx, config) {
  if (!config.inject || config.inject.length === 0) {
    throw new Error('provider-dispatcher: config.inject is required')
  }
  if (!config.setup) {
    throw new Error('provider-dispatcher: config.setup is required')
  }
  ctx.inject(config.inject, (injectedCtx) => {
    runSetup(injectedCtx, config)
  })
}

async function runSetup(ctx, config) {
  const setup = await loadModuleDefault(config.setup)
  if (typeof setup !== 'function') {
    throw new Error(`provider-dispatcher: setup module ${JSON.stringify(config.setup)} must default-export a function`)
  }

  const helpers = {
    createRecordingRegistry,
    mountChildren,
    loadModuleDefault,
    applyToolRemap,
  }

  await setup(ctx, config, helpers)
}