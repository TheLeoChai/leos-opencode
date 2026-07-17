export type Workload = {
  run(index: number): void
  consume(): number
  dispose?(): void
}

export type Variant = {
  readonly name: string
  readonly make: () => Workload
}

export function createHarness(options: { readonly samples?: number; readonly warmup?: number } = {}) {
  const samples = options.samples ?? 9
  const warmup = options.warmup ?? 500
  let checksum = 0

  return {
    samples,
    compare(iterations: number, variants: readonly Variant[]) {
      const timings = variants.map(() => [] as number[])
      for (let sample = -1; sample < samples; sample++) {
        const offset = sample < 0 ? 0 : sample % variants.length
        variants
          .map((_variant, index) => (index + offset) % variants.length)
          .forEach((variantIndex) => {
            const workload = variants[variantIndex].make()
            for (let index = 0; index < Math.min(iterations, warmup); index++) workload.run(index)
            const start = Bun.nanoseconds()
            for (let index = 0; index < iterations; index++) workload.run(index)
            const elapsed = Bun.nanoseconds() - start
            checksum += workload.consume()
            workload.dispose?.()
            if (sample >= 0) timings[variantIndex].push(elapsed / iterations)
          })
      }

      const medians = variants.map((variant, index) => {
        const median = middle(timings[index])
        const mad = middle(timings[index].map((value) => Math.abs(value - median)))
        const metric = variant.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_")
        console.log(`${variant.name.padEnd(42)} ${median.toFixed(1).padStart(10)} ns/op  +/- ${mad.toFixed(1)} MAD`)
        console.log(`METRIC ${metric}_ns_per_op=${median.toFixed(3)}`)
        return median
      })
      return {
        medians,
        ratio(left: number, right: number) {
          return middle(timings[left].map((value, index) => value / timings[right][index]))
        },
      }
    },
    finish() {
      console.log(`CHECKSUM ${checksum}`)
    },
  }
}

function middle(values: number[]) {
  return values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]
}
