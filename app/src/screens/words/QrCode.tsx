/**
 * A QR code as SVG, for the recovery card: it carries the server's address, so a new device finds the server by
 * scanning it (docs/plan.md, Appendix C). Never the words. Always black on white with a quiet zone, whatever the
 * theme: many scanners cannot read a light code on a dark ground (the one colour here that is not a theme token).
 */
import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

export function QrCode(p: { text: string; label: string; size?: number }) {
  const path = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(p.text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { d, n: n + 8 };
  }, [p.text]);
  return (
    <svg className="qr" role="img" aria-label={p.label} viewBox={`0 0 ${path.n} ${path.n}`} width={p.size ?? 160} height={p.size ?? 160} shapeRendering="crispEdges">
      <rect width={path.n} height={path.n} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}
