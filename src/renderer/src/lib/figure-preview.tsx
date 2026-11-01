import { useState, type ReactNode } from 'react'
import type { FigureSpec } from '@shared/figure-spec'
import { buildFigureScene } from '@shared/lib/figure-layout'

/** React builds the SVG allowlist. User-controlled source is only text, never innerHTML. */
export function FigurePreview({ spec }: { spec: FigureSpec }): ReactNode {
  const [tip, setTip] = useState('')
  return <div className="figure-live-preview">
    <svg viewBox="0 0 1200 720" role="img" aria-label={`${spec.title}；数据及节点可在编辑表中阅读`}>
      <defs><marker id="figure-preview-arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#53657A" /></marker></defs>
      <rect width="1200" height="720" fill="white" />
      <g fontFamily="Arial, sans-serif" fill="#182A42">
        {buildFigureScene(spec).map((mark, index) => {
          let element: ReactNode
          switch (mark.type) {
            case 'text': element = <text x={mark.x} y={mark.y} fontSize={mark.size} textAnchor={mark.anchor} fontWeight={mark.bold ? 600 : 400} transform={mark.rotate ? `rotate(${mark.rotate} ${mark.x} ${mark.y})` : undefined}>{mark.text}</text>; break
            case 'rect': element = <rect x={mark.x} y={mark.y} width={mark.width} height={mark.height} rx={mark.radius} fill={`#${mark.fill}`} stroke={mark.stroke ? `#${mark.stroke}` : 'none'} strokeWidth="2" />; break
            case 'ellipse': element = <ellipse cx={mark.x} cy={mark.y} rx={mark.rx} ry={mark.ry} fill={`#${mark.fill}`} stroke={mark.stroke ? `#${mark.stroke}` : 'none'} strokeWidth="2" />; break
            case 'line': element = <line x1={mark.x} y1={mark.y} x2={mark.x2} y2={mark.y2} stroke={`#${mark.color}`} strokeWidth={mark.width} markerEnd={mark.arrow ? 'url(#figure-preview-arrow)' : undefined} />; break
            case 'path': element = <path d={mark.d} fill={mark.fill === 'none' ? 'none' : `#${mark.fill}`} stroke={mark.stroke ? `#${mark.stroke}` : 'none'} strokeWidth={mark.width ?? 2} strokeLinejoin="round" />; break
          }
          if (!('tip' in mark) || !mark.tip) return <g key={index}>{element}</g>
          const value = mark.tip
          return <g key={index} tabIndex={0} role="graphics-symbol" aria-label={value} onFocus={() => setTip(value)} onBlur={() => setTip('')} onMouseEnter={() => setTip(value)} onMouseLeave={() => setTip('')}>
            <title>{value}</title>{element}
            {mark.type === 'ellipse' ? <circle cx={mark.x} cy={mark.y} r="12" fill="transparent" /> : null}
            {mark.type === 'rect' ? <rect x={mark.x - 8} y={mark.y - 8} width={Math.max(24, mark.width + 16)} height={Math.max(24, mark.height + 16)} fill="transparent" /> : null}
          </g>
        })}
      </g>
    </svg>
    <div className="figure-preview-tip" role="status">{tip || '悬停或聚焦数据点查看数值；完整数据保留在编辑表及 PPT 内嵌工作簿中。'}</div>
  </div>
}
