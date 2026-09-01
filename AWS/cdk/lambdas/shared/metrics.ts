// Minimal CloudWatch Embedded Metric Format (EMF) emitter.
//
// Writes a single JSON line to stdout. CloudWatch Logs automatically extracts the
// values named under `_aws.CloudWatchMetrics` into real metrics — no PutMetricData
// call, no IAM permission, and no SDK dependency (which keeps Lambda bundles and
// cold starts small). Everything else in the object is retained as a searchable
// log property.
//
// Reference: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html

type PropertyValue = string | number | boolean | undefined;

interface EmfInput {
  namespace: string;
  /** Metric dimensions. Keep cardinality low — every distinct combination is a metric. */
  dimensions?: Record<string, string>;
  /** Metric name → numeric value. */
  metrics: Record<string, number>;
  /** Extra context kept as log fields (not metrics). `undefined` values are dropped. */
  properties?: Record<string, PropertyValue>;
}

export function emitMetric({
  namespace,
  dimensions = {},
  metrics,
  properties = {},
}: EmfInput): void {
  const dimensionKeys = Object.keys(dimensions);
  const body: Record<string, unknown> = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: namespace,
          Dimensions: [dimensionKeys],
          Metrics: Object.keys(metrics).map((name) => ({ Name: name })),
        },
      ],
    },
    ...dimensions,
    ...metrics,
  };
  for (const [key, value] of Object.entries(properties)) {
    if (value !== undefined) body[key] = value;
  }
  console.log(JSON.stringify(body));
}
