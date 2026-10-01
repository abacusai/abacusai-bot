// Optional debugger instrumentation. This is disabled unless the caller passes
// --instrument-source-fetch after the coordinator approves this fixture method.
export const sourceFetchProxyScript = (home, url) => `(() => {
  const home = ${JSON.stringify(home)}, stub = ${JSON.stringify(url)};
  if (process.env.ABACUSAI_BOT_HOME !== home) throw new Error('Unexpected source home');
  if (!process.getBuiltinModule('fs').existsSync(home + '/.synthetic-cutover-home')) throw new Error('Unmarked source home');
  if (new URL(stub).hostname !== '127.0.0.1') throw new Error('Stub must be loopback');
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const target = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (target.hostname === 'routellm.abacus.ai' && ['/v1/account', '/v1/models'].includes(target.pathname))
      return original(stub + target.pathname, init);
    return Promise.resolve(new Response('{}', { status: 404 }));
  };
  return { configured: true, mode: 'debugger-configured loopback account fetch', binaryChanged: false };
})()`;
