import type { CSSProperties } from 'react';
import type { Fit } from '../../lib/prefs';
import type { Rect } from '../../lib/panels';
import { layoutPage, type Dims } from './layout';

interface Props {
  url?: string;
  dims?: Dims;
  crop?: Rect | null;
  fit: Fit;
  boxW: number;
  boxH: number;
  onDims?: (d: Dims) => void;
  style?: CSSProperties;
}

/** One page, sized explicitly so fit modes, auto-crop, spreads and zoom all compose. */
export function PageImage({ url, dims, crop, fit, boxW, boxH, onDims, style }: Props) {
  const { w, h } = layoutPage(dims, crop, fit, boxW, boxH);
  const c = crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const imgW = w / c.w;
  const imgH = h / c.h;
  return (
    <div className="page" style={{ width: w, height: h, ...style }}>
      {url ? (
        <img
          src={url}
          alt=""
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget;
            if (!dims || dims.w !== img.naturalWidth || dims.h !== img.naturalHeight) onDims?.({ w: img.naturalWidth, h: img.naturalHeight });
          }}
          style={{ width: imgW, height: imgH, left: -c.x * imgW, top: -c.y * imgH, opacity: dims ? 1 : 0 }}
        />
      ) : (
        <div className="page-loading" />
      )}
    </div>
  );
}
