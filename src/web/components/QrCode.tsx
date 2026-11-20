import qrcode from "qrcode-generator";

export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => qr.isDark(row, col)));
}

const QUIET_ZONE = 4;

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
