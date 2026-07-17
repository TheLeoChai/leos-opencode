import { createComputed, createRoot } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Keyed } from "../src"
import { createHarness, type Workload } from "./harness"

type Item = {
  readonly id: number
  readonly value: number
}

const bench = createHarness()
const results: Array<{ readonly name: string; readonly ratio: number }> = []

function initial(size: number) {
  return Array.from({ length: size }, (_, id): Item => ({ id, value: 0 }))
}

function project(values: readonly Item[]) {
  return values.reduce((total, value) => total + value.id + value.value, 0)
}

function quarkDirect(size: number, aggregate: boolean): Workload {
  const values = initial(size)
  const keyed = Keyed.make<Item, number>({
    key: (item) => item.id,
    equivalent: (left, right) => left.value === right.value,
  })
  keyed.set(values)
  const target = keyed.slots()[Math.floor(size / 2)]
  let sink = aggregate ? project(keyed.values()) : target().value
  const dispose = aggregate
    ? keyed.values.subscribe((next) => (sink = project(next)))
    : target.subscribe((value) => (sink = value.value))
  return {
    run: (index) => keyed.update({ id: Math.floor(size / 2), value: index + 1 }),
    consume: () => sink,
    dispose,
  }
}

function solidDirect(size: number, aggregate: boolean): Workload {
  let run = (_index: number) => {}
  let consume = () => 0
  let dispose = () => {}
  createRoot((rootDispose) => {
    dispose = rootDispose
    const [values, setValues] = createStore(initial(size))
    const target = Math.floor(size / 2)
    let sink = aggregate ? project(values) : values[target].value
    if (aggregate) createComputed(() => (sink = project(values)))
    else createComputed(() => (sink = values[target].value))
    run = (index) => setValues(target, reconcile({ id: target, value: index + 1 }))
    consume = () => sink
  })
  return { run, consume, dispose }
}

function quarkNoSubscriber(size: number): Workload {
  const keyed = Keyed.make<Item, number>({
    key: (item) => item.id,
    equivalent: (left, right) => left.value === right.value,
  })
  keyed.set(initial(size))
  const target = Math.floor(size / 2)
  return {
    run: (index) => keyed.update({ id: target, value: index + 1 }),
    consume: () => keyed.slots()[target]().value,
  }
}

function solidNoSubscriber(size: number): Workload {
  const [values, setValues] = createStore(initial(size))
  const target = Math.floor(size / 2)
  return {
    run: (index) => setValues(target, reconcile({ id: target, value: index + 1 })),
    consume: () => values[target].value,
  }
}

function solidPathWriteNoSubscriber(size: number): Workload {
  const [values, setValues] = createStore(initial(size))
  const target = Math.floor(size / 2)
  return {
    run: (index) => setValues(target, "value", index + 1),
    consume: () => values[target].value,
  }
}

function quarkDense(size: number): Workload {
  const keyed = Keyed.make<Item, number>({
    key: (item) => item.id,
    equivalent: (left, right) => left.value === right.value,
  })
  keyed.set(initial(size))
  let sink = project(keyed.values())
  const dispose = keyed.values.subscribe((values) => (sink = project(values)))
  return {
    run: (index) => keyed.set(initial(size).map((item) => ({ ...item, value: index + 1 }))),
    consume: () => sink,
    dispose,
  }
}

function solidDense(size: number): Workload {
  let run = (_index: number) => {}
  let consume = () => 0
  let dispose = () => {}
  createRoot((rootDispose) => {
    dispose = rootDispose
    const [values, setValues] = createStore(initial(size))
    let sink = project(values)
    createComputed(() => (sink = project(values)))
    run = (index) => setValues(reconcile(initial(size).map((item) => ({ ...item, value: index + 1 }))))
    consume = () => sink
  })
  return { run, consume, dispose }
}

function quarkUnstable(size: number): Workload {
  const keyed = Keyed.make<Item, number>({ key: (item) => item.id })
  keyed.set(initial(size))
  let sink = project(keyed.values())
  const dispose = keyed.values.subscribe((values) => (sink = project(values)))
  return {
    run(index) {
      const offset = (index + 1) * size
      keyed.set(initial(size).map((item) => ({ id: item.id + offset, value: index })))
    },
    consume: () => sink,
    dispose,
  }
}

function solidUnstable(size: number): Workload {
  let run = (_index: number) => {}
  let consume = () => 0
  let dispose = () => {}
  createRoot((rootDispose) => {
    dispose = rootDispose
    const [values, setValues] = createStore(initial(size))
    let sink = project(values)
    createComputed(() => (sink = project(values)))
    run = (index) => {
      const offset = (index + 1) * size
      setValues(reconcile(initial(size).map((item) => ({ id: item.id + offset, value: index }))))
    }
    consume = () => sink
  })
  return { run, consume, dispose }
}

function compare(name: string, iterations: number, quark: () => Workload, solid: () => Workload) {
  console.log(`\n${name}`)
  const result = bench.compare(iterations, [
    { name: `Quark ${name}`, make: quark },
    { name: `Solid ${name}`, make: solid },
  ])
  results.push({ name, ratio: result.ratio(0, 1) })
}

console.log(`Keyed integration benchmark (${bench.samples} samples)`)

compare(
  "direct no subscribers 1000",
  200_000,
  () => quarkNoSubscriber(1_000),
  () => solidNoSubscriber(1_000),
)
compare(
  "adversarial direct path write 1000",
  200_000,
  () => quarkNoSubscriber(1_000),
  () => solidPathWriteNoSubscriber(1_000),
)
compare(
  "subscribed values 10",
  100_000,
  () => quarkDirect(10, true),
  () => solidDirect(10, true),
)
compare(
  "subscribed values 100",
  25_000,
  () => quarkDirect(100, true),
  () => solidDirect(100, true),
)
compare(
  "subscribed values 1000",
  2_500,
  () => quarkDirect(1_000, true),
  () => solidDirect(1_000, true),
)
compare(
  "subscribed values 10000",
  250,
  () => quarkDirect(10_000, true),
  () => solidDirect(10_000, true),
)
compare(
  "dense update 1000",
  250,
  () => quarkDense(1_000),
  () => solidDense(1_000),
)
compare(
  "unstable keys 100",
  1_000,
  () => quarkUnstable(100),
  () => solidUnstable(100),
)

console.log("\nRatios to Solid (lower is faster)")
results.forEach((result) => {
  console.log(`${result.name.padEnd(34)} ${result.ratio.toFixed(3)}x`)
  console.log(`METRIC ${result.name.replaceAll(/[^a-z0-9]+/g, "_")}_ratio=${result.ratio.toFixed(6)}`)
})
bench.finish()
