// 在 Node 进程刚起、jsdom 还没接管 globalThis 之前，先把 Node 原生的
// AbortController / AbortSignal 存一份副本。见 tests/setup.ts 里的用法说明。
globalThis.__NODE_NATIVE_ABORT_CONTROLLER__ = globalThis.AbortController
globalThis.__NODE_NATIVE_ABORT_SIGNAL__ = globalThis.AbortSignal
