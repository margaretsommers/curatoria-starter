import test from 'node:test';
import assert from 'node:assert/strict';

type DenialState = {
  installed: boolean;
  deniedAttempts: number;
};

const stateKey = Symbol.for('curatoria.noSpendNetworkDenial');
const globalState = globalThis as typeof globalThis & {
  [stateKey]?: DenialState;
};

function denied(): never {
  const state = globalState[stateKey];
  if (state) state.deniedAttempts += 1;
  const error = new Error('Network access denied by no-spend test policy.');
  Object.assign(error, { code: 'CURATORIA_NETWORK_DENIED' });
  throw error;
}

function replace(target: object, property: string, value: unknown): void {
  Object.defineProperty(target, property, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

export function installNoSpendNetworkDenial(): DenialState {
  const existing = globalState[stateKey];
  if (existing?.installed) return existing;

  const state: DenialState = { installed: true, deniedAttempts: 0 };
  globalState[stateKey] = state;
  const http = require('node:http') as Record<string, unknown>;
  const https = require('node:https') as Record<string, unknown>;
  const net = require('node:net') as {
    Socket: { prototype: Record<string, unknown> };
  } & Record<string, unknown>;
  const tls = require('node:tls') as Record<string, unknown>;

  replace(http, 'request', denied);
  replace(http, 'get', denied);
  replace(https, 'request', denied);
  replace(https, 'get', denied);
  replace(net, 'connect', denied);
  replace(net, 'createConnection', denied);
  replace(net.Socket.prototype, 'connect', denied);
  replace(tls, 'connect', denied);
  replace(globalThis, 'fetch', denied);
  if ('WebSocket' in globalThis) replace(globalThis, 'WebSocket', denied);
  return state;
}

export function assertNetworkDeniedBeforeSocketCreation(): void {
  const http = require('node:http') as { request: (...args: unknown[]) => unknown };
  const net = require('node:net') as {
    Socket: { prototype: { connect: (...args: unknown[]) => unknown } };
  };
  const blockedConnect = net.Socket.prototype.connect;
  let socketCreationAttempts = 0;
  net.Socket.prototype.connect = (...args: unknown[]) => {
    socketCreationAttempts += 1;
    return blockedConnect(...args);
  };
  try {
    assert.throws(
      () => http.request('http://127.0.0.1:9'),
      (error: NodeJS.ErrnoException) => error.code === 'CURATORIA_NETWORK_DENIED',
    );
    assert.equal(socketCreationAttempts, 0);
  } finally {
    net.Socket.prototype.connect = blockedConnect;
  }
}

installNoSpendNetworkDenial();
assertNetworkDeniedBeforeSocketCreation();

if (process.env.CURATORIA_NETWORK_PRELOAD !== '1') {
  test('no-spend preload denies every supported network pathway before egress', () => {
    const http = require('node:http') as { get: (...args: unknown[]) => unknown };
    const https = require('node:https') as { request: (...args: unknown[]) => unknown };
    const net = require('node:net') as {
      connect: (...args: unknown[]) => unknown;
      Socket: new () => { connect: (...args: unknown[]) => unknown };
    };
    const tls = require('node:tls') as { connect: (...args: unknown[]) => unknown };
    const deniedCode = (error: NodeJS.ErrnoException) =>
      error.code === 'CURATORIA_NETWORK_DENIED';

    assertNetworkDeniedBeforeSocketCreation();
    assert.throws(() => globalThis.fetch('http://127.0.0.1:9'), deniedCode);
    assert.throws(() => http.get('http://127.0.0.1:9'), deniedCode);
    assert.throws(() => https.request('https://127.0.0.1:9'), deniedCode);
    assert.throws(() => net.connect(9, '127.0.0.1'), deniedCode);
    assert.throws(() => new net.Socket().connect(9, '127.0.0.1'), deniedCode);
    assert.throws(() => tls.connect(9, '127.0.0.1'), deniedCode);
    if ('WebSocket' in globalThis) {
      const WebSocketConstructor = globalThis.WebSocket;
      assert.throws(
        () => new WebSocketConstructor('ws://127.0.0.1:9'),
        deniedCode,
      );
    }
  });
}
