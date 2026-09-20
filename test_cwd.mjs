import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm'

// Evaluate the disk plugin with its three host-provided imports, as Desktop does.
async function loadPlugin(cwd, { wsUrl = 'ws://localhost/api/ws?ticket=test', nativeSocket = false } = {}) {
  const atom = value => ({ get: () => value, set: next => { value = next } })
  const host = { state: { gateway: atom('open'), profile: atom('default'), cwd: atom(cwd) }, notify() {} }
  const effects = [], updates = [], sockets = [], cleanups = [], timers = []
  const element = { isConnected: true, clientWidth: 800, clientHeight: 600, getBoundingClientRect: () => ({ width: 800, height: 600 }) }
  let stateIndex = 0
  class Socket {
    static OPEN = 1
    static CONNECTING = 0
    constructor(url, protocols) {
      this.url = url; this.protocols = protocols; this.protocol = ''; this.readyState = 0
      sockets.push(this)
    }
    close() { this.closed = true; this.readyState = 3 }
    send() {}
  }
  class Terminal {
    cols = 80; rows = 24
    open() {} focus() {} resize() {} dispose() {} write() {}
  }
  const context = createContext({
    URL, console: { error() {} },
    setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer },
    clearTimeout: timer => { if (timer) timer.callback = null },
    requestAnimationFrame: callback => callback(),
    crypto: { randomUUID: () => 'test-attach' },
    WebSocket: nativeSocket ? class extends WebSocket {
      constructor(...args) { super(...args); sockets.push(this) }
    } : Socket,
    TestTerminal: Terminal,
    ResizeObserver: class { observe() {} disconnect() {} },
    window: { hermesDesktop: { getGatewayWsUrl: async () => wsUrl } }
  })
  const imports = {
    '@hermes/plugin-sdk': { host, atom, useValue: atom => atom.get() },
    react: {
      useEffect: effect => effects.push(effect), useRef: current => ({ current }),
      useState: value => [stateIndex++ === 0 ? element : value, next => updates.push(next)]
    },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
  }
  const source = await readFile(new URL('./plugin.js', import.meta.url), 'utf8')
  const plugin = new SourceTextModule(source + '\nTerminalCtor = TestTerminal; export { mintPtyUrl, PluginPageContent };', { context })
  await plugin.link(specifier => {
    const values = imports[specifier]
    assert.ok(values, `Unexpected plugin dependency: ${specifier}`)
    return new SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value)
    }, { context })
  })
  await plugin.evaluate()
  return {
    mintPtyUrl: plugin.namespace.mintPtyUrl, host, sockets, updates, timers,
    async mount(duringBoot = () => {}) {
      const tree = plugin.namespace.PluginPageContent()
      for (const effect of effects) cleanups.push(effect())
      duringBoot()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(sockets.length, 1, `Expected socket; state updates: ${updates}`)
      return tree
    },
    async reconnect() {
      sockets.at(-1).onclose({ code: 1006, reason: '', wasClean: false })
      const timer = timers.find(timer => timer.callback && timer.delay === 1200)
      assert.ok(timer, 'Reconnect should be scheduled')
      timer.callback()
      await new Promise(resolve => setImmediate(resolve))
    },
    async restartEffect() {
      cleanups.pop()()
      cleanups.push(effects.at(-1)())
      await new Promise(resolve => setImmediate(resolve))
    },
    cleanup() { for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup() }
  }
}

test('component supplies Desktop-resolved cwd when starting the PTY', async t => {
  const app = await loadPlugin('/project')
  t.after(() => app.cleanup())
  await app.mount()
  assert.equal(new URL(app.sockets[0].url).searchParams.get('cwd'), '/project')
})

test('launch captures cwd before asynchronous boot and synchronously on New', async t => {
  const app = await loadPlugin('/at-open')
  t.after(() => app.cleanup())
  const tree = await app.mount(() => app.host.state.cwd.set('/during-boot'))
  assert.equal(new URL(app.sockets[0].url).searchParams.get('cwd'), '/at-open')
  app.host.state.cwd.set('/at-new')
  tree.props.children[0].props.children.find(node => node?.props?.children === 'New').props.onClick()
  app.host.state.cwd.set('/after-new')
  await app.restartEffect()
  assert.equal(new URL(app.sockets.at(-1).url).searchParams.get('cwd'), '/at-new')
})

test('explicit cwd requires backend acknowledgement before becoming connected', async t => {
  const app = await loadPlugin('/project')
  t.after(() => app.cleanup())
  await app.mount()
  const socket = app.sockets[0]
  assert.equal(socket.protocols, 'hermes-pty-cwd-v1')
  socket.readyState = 1
  socket.onopen()
  assert.equal(socket.closed, true)
  assert.ok(app.updates.some(value => typeof value === 'string' && /does not support.*cwd/.test(value)))
  assert.equal(app.updates.includes('open'), false)
})

test('failed cwd handshake reports a compatibility or connection error without retrying', async t => {
  const app = await loadPlugin('/project')
  t.after(() => app.cleanup())
  await app.mount()
  const socket = app.sockets[0]
  socket.onerror()
  socket.onclose({ code: 1006, reason: '', wasClean: false })
  assert.ok(app.updates.some(value => typeof value === 'string' && /negotiate.*cwd/.test(value)))
  assert.equal(app.timers.some(timer => timer.callback && timer.delay === 1200), false)
  assert.equal(app.updates.includes('open'), false)
})

test('real WebSocket rejects an older server handshake without retrying', {
  skip: typeof WebSocket !== 'function', timeout: 5000
}, async t => {
  const server = createServer()
  const peers = new Set()
  server.on('connection', peer => { peers.add(peer); peer.on('close', () => peers.delete(peer)) })
  server.on('upgrade', (request, peer) => {
    const accept = createHash('sha1')
      .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    peer.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`)
  })
  t.after(() => { for (const peer of peers) peer.destroy(); server.close() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const app = await loadPlugin('/project', {
    wsUrl: `ws://127.0.0.1:${server.address().port}/api/ws`, nativeSocket: true
  })
  t.after(() => app.cleanup())
  await app.mount()
  await new Promise(resolve => app.sockets[0].addEventListener('close', resolve, { once: true }))
  assert.ok(app.updates.some(value => typeof value === 'string' && /negotiate.*cwd/.test(value)))
  assert.equal(app.timers.some(timer => timer.callback && timer.delay === 1200), false)
  assert.equal(app.updates.includes('open'), false)
})

test('invalid directory errors from the gateway do not retry', async t => {
  const app = await loadPlugin('/missing')
  t.after(() => app.cleanup())
  await app.mount()
  const socket = app.sockets[0]
  socket.protocol = 'hermes-pty-cwd-v1'
  socket.onclose({ code: 4400, reason: 'cwd does not exist', wasClean: true })
  assert.ok(app.updates.includes('cwd does not exist'))
  assert.equal(app.timers.some(timer => timer.callback && timer.delay === 1200), false)
})

test('detached workspace and older Desktop omit cwd and protocol', async t => {
  for (const cwd of ['', undefined]) {
    const app = await loadPlugin(cwd)
    t.after(() => app.cleanup())
    if (cwd === undefined) delete app.host.state.cwd
    await app.mount()
    const socket = app.sockets[0]
    assert.equal(new URL(socket.url).searchParams.has('cwd'), false)
    assert.equal(socket.protocols, undefined)
    socket.readyState = 1
    socket.onopen()
    assert.ok(app.updates.includes('open'))
  }
})

test('supporting backend connects with cwd; reconnect pins it and New refreshes it', async t => {
  const app = await loadPlugin('/first')
  t.after(() => app.cleanup())
  const tree = await app.mount()
  const socket = app.sockets[0]
  socket.readyState = 1
  socket.protocol = 'hermes-pty-cwd-v1'
  socket.onopen()
  assert.ok(app.updates.includes('open'))
  app.host.state.cwd.set('/second')
  await app.reconnect()
  assert.equal(new URL(app.sockets.at(-1).url).searchParams.get('cwd'), '/first')
  const buttons = tree.props.children[0].props.children
  buttons.find(node => node?.props?.children === 'New').props.onClick()
  await app.restartEffect()
  assert.equal(new URL(app.sockets.at(-1).url).searchParams.get('cwd'), '/second')
})

test('omitted cwd preserves the existing PTY URL', async () => {
  const { mintPtyUrl } = await loadPlugin()
  assert.equal(await mintPtyUrl({ attach: 'attach', fresh: true }),
    'ws://localhost/api/pty?ticket=test&attach=attach&channel=hermes-terminal&fresh=1')
})

test('explicit invalid cwd values are rejected rather than omitted or coerced', async () => {
  const { mintPtyUrl } = await loadPlugin()
  for (const cwd of ['', null, 123, {}, '/bad\u0000path']) {
    await assert.rejects(mintPtyUrl({ cwd }), /cwd must be a non-empty string without NUL/)
  }
})

test('explicit cwd is transported intact, including URL metacharacters', async () => {
  const { mintPtyUrl } = await loadPlugin()
  const cwd = '/projects/a b/日本語 & #?'
  const url = new URL(await mintPtyUrl({ cwd, attach: 'attach', fresh: true }))
  assert.equal(url.searchParams.get('cwd'), cwd)
  assert.equal(url.searchParams.get('ticket'), 'test')
})
