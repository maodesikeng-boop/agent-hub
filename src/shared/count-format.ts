// 个数的写法（docs/ui-standard.md 第 13 条）：网页和 hub worker show 共用。

/** 计量的单位阶梯（docs/ui-standard.md 第 13 条）：K = 千，M = 百万，最大到 M。 */
const COUNT_UNITS = [
  { suffix: "", size: 1 },
  { suffix: "K", size: 1_000 },
  { suffix: "M", size: 1_000_000 },
] as const;

/** 取 3 位有效数字，去掉多余的 0：6.48、64.8、648；整数部分不止 3 位时取整。 */
const significant = (value: number) => Number(value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : value.toFixed(0));

/** 个数用英文单位：820、1.23K、291K、999K 再往上进到 1M、6.48M。不到 1000 原样。 */
export function formatCount(count: number): string {
  let unit = 0;
  while (unit < COUNT_UNITS.length - 1 && count >= COUNT_UNITS[unit + 1]!.size) unit++;
  let value = unit === 0 ? Math.round(count) : significant(count / COUNT_UNITS[unit]!.size);
  // 999_999 取 3 位有效数字是 1000K：进到下一档
  if (unit > 0 && unit < COUNT_UNITS.length - 1 && value >= 1000) value = significant(count / COUNT_UNITS[++unit]!.size);
  return `${value}${COUNT_UNITS[unit]!.suffix}`;
}
