/**
 * Lifecycle tests for provider-dispatcher: child mount/unmount/remount and
 * recording registry behavior.
 *
 * Run from the provider-dispatcher directory:
 *   npx vitest run
 */

import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createRecordingRegistry } from '../src/index.js'

function makeChildPlugin() {
  return {
    name: 'test-child',
    inject: ['web', 'tools'],
    apply(childCtx) {
      const disposeWeb = childCtx.web.registerSearchProvider({
        id: 'test',
        available() { return true },
        async search() { return { sources: [], truncated: false } },
      })
      const disposeTool = childCtx.tools.register({
        name: 'my_tool',
        description: 'A test tool',
        parameters: { type: 'object', properties: {}, required: [] },
        output: { schema: { type: 'string' }, render: (_, v) => [{ type: 'text', text: v }] },
        async execute() { return 'ok' },
      })
      return () => {
        disposeWeb()
        disposeTool()
      }
    },
  }
}

async function setupContext() {
  const ctx = new Context()
  const recordingWeb = createRecordingRegistry()
  const recordingTools = createRecordingRegistry()
  const privateCtx = ctx.isolate('web').isolate('tools')
  privateCtx.provide('web', recordingWeb)
  privateCtx.provide('tools', recordingTools)
  return { ctx, privateCtx, recordingWeb, recordingTools }
}

describe('child lifecycle', () => {
  it('mounts, records, unmounts, and remounts a child', async () => {
    const { privateCtx, recordingWeb, recordingTools } = await setupContext()

    // Mount.
    const fiber1 = await privateCtx.plugin(makeChildPlugin(), {})
    expect(recordingWeb.registrations.get('registerSearchProvider')).toHaveLength(1)
    expect(recordingTools.registrations.get('register')).toHaveLength(1)

    // Unmount.
    await fiber1.dispose()
    expect(recordingWeb.registrations.get('registerSearchProvider')).toHaveLength(0)
    expect(recordingTools.registrations.get('register')).toHaveLength(0)

    // Remount.
    const fiber2 = await privateCtx.plugin(makeChildPlugin(), {})
    expect(recordingWeb.registrations.get('registerSearchProvider')).toHaveLength(1)
    expect(recordingTools.registrations.get('register')).toHaveLength(1)

    await fiber2.dispose()
  })

  it('a disposed child removes only its own registrations', async () => {
    const { privateCtx, recordingWeb } = await setupContext()

    const fiber1 = await privateCtx.plugin(makeChildPlugin(), {})
    const fiber2 = await privateCtx.plugin({
      ...makeChildPlugin(),
      apply(childCtx) {
        const d = childCtx.web.registerSearchProvider({
          id: 'test-2',
          available() { return true },
          async search() { return { sources: [], truncated: false } },
        })
        return () => d()
      },
    }, {})

    expect(recordingWeb.registrations.get('registerSearchProvider')).toHaveLength(2)

    await fiber1.dispose()
    const remaining = recordingWeb.registrations.get('registerSearchProvider') ?? []
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe('test-2')

    await fiber2.dispose()
  })
})