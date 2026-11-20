const COUNT_UNITS = [
  { suffix: "", size: 1 },
  { suffix: "K", size: 1_000 },
  { suffix: "M", size: 1_000_000 },
] as const;

const significant = (value: number) => Number(value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : value.toFixed(0));

export function formatCount(count: number): string {
  let unit = 0;
  while (unit < COUNT_UNITS.length - 1 && count >= COUNT_UNITS[unit + 1]!.size) unit++;
  let value = unit === 0 ? Math.round(count) : significant(count / COUNT_UNITS[unit]!.size);
  if (unit > 0 && unit < COUNT_UNITS.length - 1 && value >= 1000) value = significant(count / COUNT_UNITS[++unit]!.size);
  return `${value}${COUNT_UNITS[unit]!.suffix}`;
}
