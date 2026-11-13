// App version strings ("0.2.1", "0.3.0-beta.1"): validation and semantic-version order.

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && VERSION.test(value);
}

/** Semantic version order (prerelease before its release); NaN when either is not a version. */
export function compareVersions(a: string, b: string): number {
  const x = VERSION.exec(a);
  const y = VERSION.exec(b);
  if (!x || !y) return NaN;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return Math.sign(d);
  }
  const [pa, pb] = [x[4], y[4]];
  if (pa === pb) return 0;
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  const sa = pa.split('.');
  const sb = pb.split('.');
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const ea = sa[i];
    const eb = sb[i];
    if (ea === undefined) return -1;
    if (eb === undefined) return 1;
    const na = /^\d+$/.test(ea) ? Number(ea) : NaN;
    const nb = /^\d+$/.test(eb) ? Number(eb) : NaN;
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return Math.sign(na - nb);
    } else if (!Number.isNaN(na)) return -1;
    else if (!Number.isNaN(nb)) return 1;
    else if (ea !== eb) return ea < eb ? -1 : 1;
  }
  return 0;
}
