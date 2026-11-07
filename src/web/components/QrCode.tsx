// 二维码：用 qrcode-generator 算点阵，自己画成一个 SVG（不拼 HTML 字符串）。二维码要深色点配浅色底才扫得出，
// 所以底色一直是白（--background），点是前景色，四周留 4 格空白（标准规定的安静区）。
import qrcode from "qrcode-generator";

/** 点阵：true 是深色点。纠错等级 M（约 15%）；版本号自动按内容长度选。 */
export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => qr.isDark(row, col)));
}

/** 安静区：点阵四周的空白，单位是格。 */
const QUIET_ZONE = 4;

/** 一整行连续的深色点合成一段，路径短得多。 */
function modulesPath(modules: boolean[][]): string {
  const parts: string[] = [];
  modules.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x++;
      parts.push(`M${start + QUIET_ZONE} ${y + QUIET_ZONE}h${x - start}v1h-${x - start}z`);
    }
  });
  return parts.join("");
}

export function QrCode({ text, label, className }: { text: string; label: string; className?: string }) {
  const modules = qrModules(text);
  const side = modules.length + QUIET_ZONE * 2;
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${side} ${side}`} shapeRendering="crispEdges" className={className}>
      <rect width={side} height={side} className="fill-background" />
      <path d={modulesPath(modules)} className="fill-foreground" />
    </svg>
  );
}
