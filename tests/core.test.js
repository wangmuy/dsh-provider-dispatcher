/**
 * Unit tests for provider-dispatcher core logic.
 *
 * Run from the provider-dispatcher directory:
 *   npx vitest run
 */

import { describe, it, expect } from 'vitest'
import { createRecordingRegistry, applyToolRemap } from '../src/index.js'

describe('createRecordingRegistry', () => {
  it('records a registerSearchProvider call', () => {
    const registry = createRecordingRegistry()
    const provider = { id: 'test', available: () => true, search: async () => ({ sources: [] }) }
    const dispose = registry.registerSearchProvider(provider)
    expect(registry.registrations.get('registerSearchProvider')).toEqual([provider])
    // Dispose removes the provider.
    dispose()
    expect(registry.registrations.get('registerSearchProvider')).toEqual([])
  })

  it('records multiple register calls of different methods', () => {
    const registry = createRecordingRegistry()
    registry.registerSearchProvider({ id: 'a' })
    registry.registerFetchProvider({ id: 'b' })
    registry.register('tool-def-1')
    expect(registry.registrations.get('registerSearchProvider')?.length).toBe(1)
    expect(registry.registrations.get('registerFetchProvider')?.length).toBe(1)
    expect(registry.registrations.get('register')?.length).toBe(1)
  })

  it('removes the correct provider on dispose', () => {
    const registry = createRecordingRegistry()
    const p1 = { id: 'a' }
    const p2 = { id: 'b' }
    const d1 = registry.registerSearchProvider(p1)
    registry.registerSearchProvider(p2)
    d1()
    expect(registry.registrations.get('registerSearchProvider')).toEqual([p2])
  })

  it('list() returns all registrations', () => {
    const registry = createRecordingRegistry()
    registry.registerSearchProvider({ id: 'a' })
    registry.register('tool-1')
    const list = registry.list()
    expect(list.registerSearchProvider).toHaveLength(1)
    expect(list.register).toHaveLength(1)
  })

  it('non-register properties return undefined', () => {
    const registry = createRecordingRegistry()
    expect(registry.search).toBeUndefined()
    expect(registry.available).toBeUndefined()
  })
})

describe('applyToolRemap', () => {
  it('returns empty disposer when remap is undefined', () => {
    const ctx = { get: () => ({}) }
    const recordingTools = createRecordingRegistry()
    const dispose = applyToolRemap(ctx, recordingTools, undefined)
    expect(typeof dispose).toBe('function')
    dispose() // should not throw
  })

  it('re-registers captured tools under new names', () => {
    const tools = []
    const globalTools = {
      register(tool) { tools.push(tool); return () => { tools.length = 0 } },
    }
    const ctx = { get: () => globalTools }
    const recordingTools = createRecordingRegistry()
    recordingTools.register({ name: 'x_search', description: 'original' })

    const dispose = applyToolRemap(ctx, recordingTools, { x_search: 'search_x' })
    expect(tools.map(t => t.name)).toEqual(['search_x'])
    expect(tools[0].description).toBe('original')

    // Dispose removes the remapped tool.
    dispose()
    expect(tools).toHaveLength(0)
  })

  it('re-registers with new name, not old name', () => {
    const tools = []
    const globalTools = {
      register(tool) { tools.push(tool); return () => { tools.length = 0 } },
    }
    const ctx = { get: () => globalTools }
    const recordingTools = createRecordingRegistry()
    recordingTools.register({ name: 'my_tool' })

    applyToolRemap(ctx, recordingTools, { my_tool: 'renamed' })
    expect(tools[0].name).toBe('renamed')
  })

  it('skips tools not in remap', () => {
    const tools = []
    const globalTools = {
      register(tool) { tools.push(tool); return () => { tools.length = 0 } },
    }
    const ctx = { get: () => globalTools }
    const recordingTools = createRecordingRegistry()
    recordingTools.register({ name: 'keep_me' })
    recordingTools.register({ name: 'remap_me' })

    applyToolRemap(ctx, recordingTools, { remap_me: 'renamed' })
    expect(tools.map(t => t.name)).toEqual(['renamed'])
  })

  it('returns empty disposer when no tools are captured', () => {
    const ctx = { get: () => ({}) }
    const recordingTools = createRecordingRegistry()
    const dispose = applyToolRemap(ctx, recordingTools, { x: 'y' })
    expect(typeof dispose).toBe('function')
    dispose()
  })
})