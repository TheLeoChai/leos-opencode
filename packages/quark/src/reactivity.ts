export interface Readable<A> {
  (): A
  subscribe(listener: (value: A) => void): () => void
}

export interface Writable<A> extends Readable<A> {
  set(value: A): void
  update(f: (value: A) => A): void
}

export namespace State {
  export function make<A>(initial: A): Writable<A> {
    const node: StateNode<A> = {
      flags: Flags.Mutable,
      value: initial,
      pending: initial,
      deps: undefined,
      depsTail: undefined,
      subs: undefined,
      subsTail: undefined,
    }
    const read = (() => readState(node)) as Writable<A>
    read.set = (value) => writeState(node, value)
    read.update = (f) => {
      // Read untracked: calling update inside a tracked evaluation must not
      // make the caller depend on (and re-trigger from) this state.
      const previous = swapActiveSub(undefined)
      try {
        writeState(node, f(readState(node)))
      } finally {
        activeSub = previous
      }
    }
    read.subscribe = (listener) => subscribeNode(node, read, listener)
    return read
  }
}

export namespace Computed {
  export function make<A>(evaluate: (previous: A | undefined) => A): Readable<A> {
    const node: ComputedNode<A> = {
      flags: Flags.None,
      value: undefined,
      evaluate,
      deps: undefined,
      depsTail: undefined,
      subs: undefined,
      subsTail: undefined,
    }
    const read = (() => readComputed(node)) as Readable<A>
    read.subscribe = (listener) => subscribeNode(node, read, listener)
    return read
  }
}

export namespace Transaction {
  export function run<A>(f: () => A): A {
    batchDepth++
    try {
      return f()
    } finally {
      if (!--batchDepth) flush()
    }
  }
}

// Internal reactive kernel.
//
// The dependency graph representation (intrusive doubly-linked dependency and
// subscriber links with versioned in-place reuse) and the iterative
// `propagate`/`checkDirty` walks are adapted from alien-signals 3.2.1
// (https://github.com/stackblitz/alien-signals, MIT). See
// THIRD_PARTY_NOTICES.md. Quark departs from the reference in three ways:
// subscribers are fixed single-dependency watchers instead of general
// effects, orphaned computeds are detached with an iterative work queue
// instead of recursive unwatch callbacks, and reading a computed that is
// currently evaluating throws a stable cycle error instead of looping
// (stackblitz/alien-signals#118, #123).

const enum Flags {
  None = 0,
  /** The node can produce a new value: states always, computeds once evaluated. */
  Mutable = 1,
  /** The node is a subscription watcher delivering values to a listener. */
  Watching = 2,
  /** The computed is currently evaluating; reading it again is a cycle. */
  Computing = 4,
  /** The watcher is queued for the next flush. */
  Queued = 8,
  /** The node's value is known stale. */
  Dirty = 16,
  /** The node's value is possibly stale pending dependency revalidation. */
  Pending = 32,
}

interface ReactiveNode {
  flags: Flags
  deps?: Link
  depsTail?: Link
  subs?: Link
  subsTail?: Link
}

interface StateNode<A = unknown> extends ReactiveNode {
  value: A
  pending: A
}

interface ComputedNode<A = unknown> extends ReactiveNode {
  value: A | undefined
  evaluate: (previous: A | undefined) => A
}

interface WatcherNode extends ReactiveNode {
  read: () => unknown
  listener: (value: unknown) => void
}

interface Link {
  version: number
  dep: ReactiveNode
  sub: ReactiveNode
  prevSub: Link | undefined
  nextSub: Link | undefined
  prevDep: Link | undefined
  nextDep: Link | undefined
}

interface Stack<A> {
  value: A
  prev: Stack<A> | undefined
}

let activeSub: ReactiveNode | undefined
let batchDepth = 0
let version = 0
let flushIndex = 0
let queueLength = 0
const queue: Array<WatcherNode | undefined> = []
const orphans: Array<ReactiveNode> = []

function swapActiveSub(sub: ReactiveNode | undefined): ReactiveNode | undefined {
  const previous = activeSub
  activeSub = sub
  return previous
}

function readState<A>(node: StateNode<A>): A {
  if (node.flags & Flags.Dirty && updateState(node) && node.subs !== undefined) {
    shallowPropagate(node.subs)
  }
  if (activeSub !== undefined) link(node, activeSub, version)
  return node.value
}

function writeState<A>(node: StateNode<A>, value: A): void {
  if (node.pending === (node.pending = value)) return
  node.flags = Flags.Mutable | Flags.Dirty
  if (node.subs !== undefined) {
    propagate(node.subs)
    if (!batchDepth) flush()
  }
}

function readComputed<A>(node: ComputedNode<A>): A {
  const flags = node.flags
  if (flags & Flags.Computing) {
    throw new Error("Reactive cycle detected: a computed depends on its own value")
  }
  if (
    flags & Flags.Dirty ||
    (flags & Flags.Pending &&
      (checkDirty(node.deps!, node) || ((node.flags = flags & ~Flags.Pending), false))) ||
    !flags
  ) {
    if (updateComputed(node) && node.subs !== undefined) {
      shallowPropagate(node.subs)
    }
  }
  if (activeSub !== undefined) link(node, activeSub, version)
  return node.value!
}

function updateState(node: StateNode): boolean {
  node.flags = Flags.Mutable
  return node.value !== (node.value = node.pending)
}

function updateComputed<A>(node: ComputedNode<A>): boolean {
  node.depsTail = undefined
  node.flags = Flags.Mutable | Flags.Computing
  const previous = swapActiveSub(node)
  version++
  let completed = false
  try {
    const oldValue = node.value
    const changed = oldValue !== (node.value = node.evaluate(oldValue))
    completed = true
    return changed
  } finally {
    activeSub = previous
    node.flags &= ~Flags.Computing
    // A throwing evaluation stays dirty so the next read retries instead of
    // serving a stale value with no dependency links.
    if (!completed) node.flags |= Flags.Dirty
    purgeDeps(node)
  }
}

function subscribeNode<A>(node: ReactiveNode, read: () => A, listener: (value: A) => void): () => void {
  // Evaluate untracked before linking so a throwing computed leaves no
  // partially initialized watcher behind.
  const previous = swapActiveSub(undefined)
  try {
    read()
  } finally {
    activeSub = previous
  }
  const watcher: WatcherNode = {
    flags: Flags.Watching,
    read,
    listener: listener as (value: unknown) => void,
    deps: undefined,
    depsTail: undefined,
  }
  link(node, watcher, ++version)
  return () => {
    if (!(watcher.flags & Flags.Watching)) return
    watcher.flags &= ~(Flags.Watching | Flags.Dirty | Flags.Pending)
    unlink(watcher.deps!, watcher)
    drainOrphans()
  }
}

function runWatcher(watcher: WatcherNode): void {
  const flags = watcher.flags
  watcher.flags = flags & ~(Flags.Queued | Flags.Dirty | Flags.Pending)
  if (!(flags & Flags.Watching)) return
  const dirty =
    !!(flags & Flags.Dirty) || (!!(flags & Flags.Pending) && checkDirty(watcher.deps!, watcher))
  // Revalidation runs user code in computed evaluations, which may dispose
  // this watcher; a disposed watcher must not deliver.
  if (!dirty || !(watcher.flags & Flags.Watching)) return
  // Listener reads stay untracked and listeners may dispose subscriptions,
  // including their own.
  const previous = swapActiveSub(undefined)
  try {
    watcher.listener(watcher.read())
  } finally {
    activeSub = previous
  }
}

function flush(): void {
  try {
    while (flushIndex < queueLength) {
      const watcher = queue[flushIndex]!
      queue[flushIndex++] = undefined
      runWatcher(watcher)
    }
  } finally {
    // A throwing listener aborts this flush; the remaining watchers keep
    // their Dirty/Pending flags and requeue on the next propagation.
    while (flushIndex < queueLength) {
      const watcher = queue[flushIndex]!
      queue[flushIndex++] = undefined
      watcher.flags &= ~Flags.Queued
    }
    flushIndex = 0
    queueLength = 0
  }
}

function enqueue(watcher: WatcherNode): void {
  watcher.flags |= Flags.Queued
  queue[queueLength++] = watcher
}

function link(dep: ReactiveNode, sub: ReactiveNode, linkVersion: number): void {
  const prevDep = sub.depsTail
  if (prevDep !== undefined && prevDep.dep === dep) return
  const nextDep = prevDep !== undefined ? prevDep.nextDep : sub.deps
  if (nextDep !== undefined && nextDep.dep === dep) {
    nextDep.version = linkVersion
    sub.depsTail = nextDep
    return
  }
  const prevSub = dep.subsTail
  if (prevSub !== undefined && prevSub.version === linkVersion && prevSub.sub === sub) return
  const newLink: Link = {
    version: linkVersion,
    dep,
    sub,
    prevDep,
    nextDep,
    prevSub,
    nextSub: undefined,
  }
  sub.depsTail = newLink
  dep.subsTail = newLink
  if (nextDep !== undefined) nextDep.prevDep = newLink
  if (prevDep !== undefined) prevDep.nextDep = newLink
  else sub.deps = newLink
  if (prevSub !== undefined) prevSub.nextSub = newLink
  else dep.subs = newLink
}

function unlink(current: Link, sub: ReactiveNode): Link | undefined {
  const dep = current.dep
  const prevDep = current.prevDep
  const nextDep = current.nextDep
  const nextSub = current.nextSub
  const prevSub = current.prevSub
  if (nextDep !== undefined) nextDep.prevDep = prevDep
  else sub.depsTail = prevDep
  if (prevDep !== undefined) prevDep.nextDep = nextDep
  else sub.deps = nextDep
  if (nextSub !== undefined) nextSub.prevSub = prevSub
  else dep.subsTail = prevSub
  if (prevSub !== undefined) prevSub.nextSub = nextSub
  else if ((dep.subs = nextSub) === undefined && dep.deps !== undefined) orphans.push(dep)
  return nextDep
}

// Detaches computeds that lost their last subscriber. Iterative on purpose:
// a recursive unwatch cascade overflows the stack on deep chains. Only nodes
// with dependencies enter the queue (states and dep-less computeds have
// nothing to detach). As in the reference, a computed that is read but never
// subscribed stays linked to its sources until they are collected; create
// long-lived computeds rather than per-operation ones.
function drainOrphans(): void {
  while (orphans.length > 0) {
    const node = orphans.pop()!
    if (!("evaluate" in node) || node.depsTail === undefined) continue
    node.flags = Flags.Mutable | Flags.Dirty
    let current = node.depsTail as Link | undefined
    while (current !== undefined) {
      const prev = current.prevDep
      unlink(current, node)
      current = prev
    }
  }
}

function purgeDeps(sub: ReactiveNode): void {
  const depsTail = sub.depsTail
  let dep = depsTail !== undefined ? depsTail.nextDep : sub.deps
  while (dep !== undefined) {
    dep = unlink(dep, sub)
  }
  drainOrphans()
}

function propagate(current: Link): void {
  let next = current.nextSub
  let stack: Stack<Link | undefined> | undefined

  top: do {
    const sub = current.sub
    const flags = sub.flags
    const unmarked = !(flags & (Flags.Dirty | Flags.Pending))
    if (unmarked) sub.flags = flags | Flags.Pending
    if (flags & Flags.Watching && !(flags & Flags.Queued)) enqueue(sub as WatcherNode)

    if (unmarked && flags & Flags.Mutable) {
      const subSubs = sub.subs
      if (subSubs !== undefined) {
        current = subSubs
        const nextSub = subSubs.nextSub
        if (nextSub !== undefined) {
          stack = { value: next, prev: stack }
          next = nextSub
        }
        continue
      }
    }

    if (next !== undefined) {
      current = next
      next = current.nextSub
      continue
    }

    while (stack !== undefined) {
      const continuation = stack.value
      stack = stack.prev
      if (continuation !== undefined) {
        current = continuation
        next = current.nextSub
        continue top
      }
    }

    break
  } while (true)
}

function shallowPropagate(current: Link): void {
  let iterator: Link | undefined = current
  do {
    const sub = iterator.sub
    const flags = sub.flags
    if ((flags & (Flags.Pending | Flags.Dirty)) === Flags.Pending) {
      sub.flags = flags | Flags.Dirty
      if (flags & Flags.Watching && !(flags & Flags.Queued)) enqueue(sub as WatcherNode)
    }
    iterator = iterator.nextSub
  } while (iterator !== undefined)
}

function updateNode(node: ReactiveNode): boolean {
  if ("evaluate" in node) return updateComputed(node as ComputedNode)
  return updateState(node as StateNode)
}

function checkDirty(current: Link, sub: ReactiveNode): boolean {
  let stack: Stack<Link> | undefined
  let checkDepth = 0
  let dirty = false

  top: do {
    const dep = current.dep
    const flags = dep.flags

    if (sub.flags & Flags.Dirty) {
      dirty = true
    } else if ((flags & (Flags.Mutable | Flags.Dirty)) === (Flags.Mutable | Flags.Dirty)) {
      const subs = dep.subs!
      if (updateNode(dep)) {
        if (subs.nextSub !== undefined) shallowPropagate(subs)
        dirty = true
      }
    } else if ((flags & (Flags.Mutable | Flags.Pending)) === (Flags.Mutable | Flags.Pending)) {
      stack = { value: current, prev: stack }
      current = dep.deps!
      sub = dep
      checkDepth++
      continue
    }

    if (!dirty) {
      const nextDep = current.nextDep
      if (nextDep !== undefined) {
        current = nextDep
        continue
      }
    }

    while (checkDepth--) {
      current = stack!.value
      stack = stack!.prev
      if (dirty) {
        const subs = sub.subs!
        if (updateNode(sub)) {
          if (subs.nextSub !== undefined) shallowPropagate(subs)
          sub = current.sub
          continue
        }
        dirty = false
      } else {
        sub.flags &= ~Flags.Pending
      }
      sub = current.sub
      const nextDep = current.nextDep
      if (nextDep !== undefined) {
        current = nextDep
        continue top
      }
    }

    return dirty
  } while (true)
}
