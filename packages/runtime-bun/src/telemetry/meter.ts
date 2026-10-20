import type {
  FrameworkMetric,
  GaugePoint,
  HistogramPoint,
  MetricRecord,
  SumPoint,
  TelemetryAttributes
} from "@holqa/core";

import { metricOverflowAttribute } from "@holqa/core";

/** One observation a gauge callback reports. */
export interface GaugeObservation {
  readonly value: number;
  readonly attributes?: TelemetryAttributes;
}

/** Settings of a {@link Meter}. */
export interface MeterOptions {
  /** The most attribute combinations one metric tracks; further combinations are aggregated into one overflow series. */
  readonly maxSeries: number;
  /** The wall clock in epoch milliseconds. */
  readonly wallNow: () => number;
  /** Reports a gauge whose callback failed; the gauge is left out of that collection. */
  readonly onGaugeError?: (metric: string, error: unknown) => void;
}

/**
 * Default histogram boundaries for durations in seconds, the advisory
 * boundaries of OpenTelemetry's HTTP and messaging duration metrics.
 */
export const durationBuckets: readonly number[] = Object.freeze([0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10]);

/** One histogram series. */
interface HistogramSeries {
  readonly attributes: TelemetryAttributes;
  count: number;
  sum: number;
  min: number;
  max: number;
  readonly bucketCounts: number[];
}

/**
 * Keeps attributes a metric allows, in key order, so each combination maps
 * to one series key.
 *
 * @param metric - The metric and its attribute allowlist.
 * @param attributes - The attributes of one measurement.
 * @returns The kept attributes and their series key.
 */
function seriesOf(metric: FrameworkMetric, attributes: TelemetryAttributes | undefined): { readonly attributes: TelemetryAttributes; readonly key: string } {
  const kept: Record<string, string | number | boolean> = {};
  for (const name of [...metric.attributes].sort()) {
    const value = attributes?.[name];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      kept[name] = value;
  }
  return { attributes: kept, key: JSON.stringify(kept) };
}

/**
 * Aggregates framework metrics in memory: cumulative counters, cumulative
 * explicit-bucket histograms and callback gauges. Attributes outside a
 * metric's allowlist are dropped before aggregation, and each metric tracks
 * at most `maxSeries` attribute combinations, so neither memory nor exported
 * series grow with traffic.
 */
export class Meter {
  /** Settings. */
  private readonly options: MeterOptions;
  /** When accumulation started. */
  private readonly startTime: number;
  /** Counter series by metric name. */
  private readonly counters = new Map<string, { readonly metric: FrameworkMetric; readonly series: Map<string, { readonly attributes: TelemetryAttributes; value: number }> }>();
  /** Histogram series by metric name. */
  private readonly histograms = new Map<string, { readonly metric: FrameworkMetric; readonly bounds: readonly number[]; readonly series: Map<string, HistogramSeries> }>();
  /** Gauge callbacks by metric name. */
  private readonly gauges = new Map<string, { readonly metric: FrameworkMetric; readonly observe: () => Promise<readonly GaugeObservation[]> | readonly GaugeObservation[] }>();

  /**
   * Creates a meter.
   *
   * @param options - The series limit and the clock.
   */
  constructor(options: MeterOptions) {
    this.options = options;
    this.startTime = options.wallNow();
  }

  /**
   * Adds to a counter.
   *
   * @param metric - The counter's definition.
   * @param value - A non-negative amount.
   * @param attributes - The measurement's attributes; only allowed keys are kept.
   */
  add(metric: FrameworkMetric, value: number, attributes?: TelemetryAttributes): void {
    if (!(value >= 0) || !Number.isFinite(value))
      return;
    let counter = this.counters.get(metric.name);
    if (counter === undefined) {
      counter = { metric, series: new Map() };
      this.counters.set(metric.name, counter);
    }
    const { attributes: kept, key } = this.limit(counter.series, seriesOf(metric, attributes));
    const series = counter.series.get(key);
    if (series === undefined)
      counter.series.set(key, { attributes: kept, value });
    else
      series.value += value;
  }

  /**
   * Records one value in a histogram.
   *
   * @param metric - The histogram's definition.
   * @param value - The measured value, for example a duration in seconds.
   * @param attributes - The measurement's attributes; only allowed keys are kept.
   * @param bounds - Bucket boundaries, used when the histogram is first recorded.
   */
  record(metric: FrameworkMetric, value: number, attributes?: TelemetryAttributes, bounds: readonly number[] = durationBuckets): void {
    if (!Number.isFinite(value))
      return;
    let histogram = this.histograms.get(metric.name);
    if (histogram === undefined) {
      histogram = { metric, bounds, series: new Map() };
      this.histograms.set(metric.name, histogram);
    }
    const { attributes: kept, key } = this.limit(histogram.series, seriesOf(metric, attributes));
    let series = histogram.series.get(key);
    if (series === undefined) {
      series = { attributes: kept, count: 0, sum: 0, min: value, max: value, bucketCounts: Array.from<number>({ length: histogram.bounds.length + 1 }).fill(0) };
      histogram.series.set(key, series);
    }
    series.count += 1;
    series.sum += value;
    series.min = Math.min(series.min, value);
    series.max = Math.max(series.max, value);
    const bucket = histogram.bounds.findIndex(bound => value <= bound);
    series.bucketCounts[bucket === -1 ? histogram.bounds.length : bucket]! += 1;
  }

  /**
   * Registers a gauge whose values are observed at each collection.
   *
   * @param metric - The gauge's definition.
   * @param observe - Returns the current values; a callback that throws is skipped for that collection.
   */
  gauge(metric: FrameworkMetric, observe: () => Promise<readonly GaugeObservation[]> | readonly GaugeObservation[]): void {
    this.gauges.set(metric.name, { metric, observe });
  }

  /**
   * Collects every metric's current points.
   *
   * @returns One record per metric with at least one point, sorted by name.
   */
  async collect(): Promise<MetricRecord[]> {
    const time = this.options.wallNow();
    const { startTime } = this;
    const records: MetricRecord[] = [];
    for (const { metric, series } of this.counters.values()) {
      const points: SumPoint[] = [...series.values()].map(entry => ({ attributes: entry.attributes, startTime, time, value: entry.value }));
      records.push({ type: "sum", monotonic: true, name: metric.name, description: metric.description, unit: metric.unit, points });
    }
    for (const { metric, bounds, series } of this.histograms.values()) {
      const points: HistogramPoint[] = [...series.values()].map(entry => ({ attributes: entry.attributes, startTime, time, count: entry.count, sum: entry.sum, min: entry.min, max: entry.max, bounds, bucketCounts: [...entry.bucketCounts] }));
      records.push({ type: "histogram", name: metric.name, description: metric.description, unit: metric.unit, points });
    }
    for (const { metric, observe } of this.gauges.values()) {
      let observations: readonly GaugeObservation[];
      try {
        observations = await observe();
      } catch (error) {
        // A gauge whose source is unavailable (for example a closed binding) is
        // reported and left out of this collection; the next collection tries again.
        this.options.onGaugeError?.(metric.name, error);
        continue;
      }
      const series = new Map<string, TelemetryAttributes>();
      const values = new Map<string, number>();
      for (const observation of observations) {
        if (!Number.isFinite(observation.value))
          continue;
        const { attributes: kept, key } = this.limit(series, seriesOf(metric, observation.attributes));
        series.set(key, kept);
        // Observations beyond the series limit are added up in the overflow series.
        values.set(key, (values.get(key) ?? 0) + observation.value);
      }
      const points: GaugePoint[] = [...series].map(([key, attributes]) => ({ attributes, time, value: values.get(key)! }));
      if (points.length > 0)
        records.push({ type: "gauge", name: metric.name, description: metric.description, unit: metric.unit, points });
    }
    return records.filter(record => record.points.length > 0).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  }

  /**
   * Redirects a new series to the overflow series once a metric has reached its limit.
   *
   * @param existing - The metric's series.
   * @param candidate - The measurement's series.
   * @param candidate.attributes - Its attributes.
   * @param candidate.key - Its series key.
   * @returns The series to record into.
   */
  private limit(existing: ReadonlyMap<string, unknown>, candidate: { readonly attributes: TelemetryAttributes; readonly key: string }): { readonly attributes: TelemetryAttributes; readonly key: string } {
    if (existing.has(candidate.key) || existing.size < this.options.maxSeries)
      return candidate;
    const attributes = { [metricOverflowAttribute]: true };
    return { attributes, key: JSON.stringify(attributes) };
  }
}