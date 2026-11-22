const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];

// Cada linha usa a mediana das diferenças locais para reduzir reflexos estreitos.
export function estimateLevel(reference, frame, sensitivity) {
  const { width, height, data } = frame;
  const rows = Array.from({ length: height }, (_, y) => {
    const distances = Array.from({ length: width }, (_, x) => {
      const i = (y * width + x) * 4;
      return (Math.abs(data[i] - reference[i])
        + Math.abs(data[i + 1] - reference[i + 1])
        + Math.abs(data[i + 2] - reference[i + 2])) / 3;
    });
    return median(distances);
  });
  const smooth = rows.map((_, y) => median(rows.slice(Math.max(0, y - 2), y + 3)));
  const changed = smooth.map((value) => value >= sensitivity);

  // Ajusta um único degrau, com região vazia no topo e líquido abaixo.
  let loss = changed.filter(Boolean).length;
  let bestLoss = loss;
  let boundary = height;
  for (let y = height - 1; y >= 0; y--) {
    loss += changed[y] ? -1 : 1;
    if (loss < bestLoss) {
      bestLoss = loss;
      boundary = y;
    }
  }
  if (bestLoss > height * 0.15) return null;
  return Math.round(100 * (height - boundary) / height);
}

export class AlarmTimer {
  since = null;
  lastSample = null;
  silenced = false;

  reset() {
    this.since = this.lastSample = null;
    this.silenced = false;
  }

  update(level, limit, now) {
    if (level === null || level <= limit) {
      this.reset();
      return 0;
    }
    if (this.lastSample !== null && now - this.lastSample > 1500) this.reset();
    this.lastSample = now;
    this.since ??= now;
    return Math.min(30000, now - this.since);
  }
}
