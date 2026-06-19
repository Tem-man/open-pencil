# HTML 导出功能实现方案

> 本文档分析 OpenPencil 现有导出基础设施，评估 HTML 导出的技术可行性，并给出完整的实现路径。

---

## 一、可行性结论

**完全可行，且有两条成本不同的路径可选。**

项目已具备以下基础能力：

| 现有能力 | 对 HTML 导出的价值 |
|---|---|
| `SceneNode` 完整属性（fills/strokes/effects/text/layout） | HTML 样式的数据来源 |
| Tailwind JSX 生成（`tailwind-classes.ts`） | 直接复用 CSS 属性映射逻辑 |
| SVG 导出（`io/formats/svg/`） | 矢量图形、渐变、路径的备用方案 |
| `IORegistry` + `IOFormatAdapter` | 新格式只需实现同一接口即可注册 |
| CLI `export` 命令 | 天然支持命令行批量导出 |
| MCP 工具链 | AI 可驱动 HTML 导出 |

---

## 二、方案选型

### 方案 A：内联 CSS 静态 HTML（推荐）

将 `SceneNode` 树递归转换为带内联 `style` 属性的 `<div>` 树，输出一个零依赖的独立 `.html` 文件。

```
SceneGraph
  └── nodeToHTMLElement()         ← 递归，每个节点 → <div style="...">
        ├── nodeToInlineCSS()     ← SceneNode → CSS 属性字典
        ├── renderFills()         ← SOLID → background-color / GRADIENT → linear-gradient
        ├── renderStrokes()       ← border / outline / box-shadow
        ├── renderEffects()       ← box-shadow / filter: blur()
        ├── renderLayout()        ← flexbox / grid / position: absolute
        └── renderText()          ← font-* / color / line-height
  └── wrapHTMLDocument()          ← <!DOCTYPE html> + <head> + <body>
```

**优点**：零依赖、任何浏览器直接打开、像素级接近设计稿  
**缺点**：内联样式冗长，无法直接交给前端工程师维护

### 方案 B：Tailwind CDN HTML

复用已有的 `collectTailwindClasses()` 生成 className，输出一个引用 Tailwind Play CDN 的 HTML 文件。

```html
<script src="https://cdn.tailwindcss.com"></script>
<div class="w-[390px] flex flex-col bg-white ...">
  <div class="w-full h-14 flex flex-row ...">...</div>
</div>
```

**优点**：直接复用现有代码、输出简洁  
**缺点**：依赖 CDN、任意值类名需要 `tailwind.config` 的 `safelist`、渐变/图片等不支持

### 方案 C：CSS 类 + 语义 HTML（进阶）

生成独立的 `<style>` 块加语义化 HTML，适合交给前端工程师二次开发。不在本期讨论范围。

---

**本文档以方案 A 为主要实现路径，方案 B 作为额外选项。**

---

## 三、整体架构设计

### 新增文件结构

```
packages/core/src/io/formats/html/
├── index.ts              # 公共 API 入口（export renderNodesToHTML）
├── export.ts             # IOFormatAdapter 实现
├── node.ts               # 核心：nodeToHTMLElement() 递归树遍历
├── css.ts                # SceneNode → CSS 属性字典
├── fills.ts              # fills → CSS background/gradient
├── strokes.ts            # strokes → CSS border/outline
├── effects.ts            # effects → CSS box-shadow/filter
├── layout.ts             # 布局 → flexbox/grid/position
├── text.ts               # 文本节点 → CSS + 内容
├── image.ts              # 图片 fill → base64 data URI 嵌入
└── template.ts           # <!DOCTYPE html> 文档包装
```

### 在 `formats.ts` 注册新格式

```typescript
// packages/core/src/io/formats.ts
import { htmlFormat } from './formats/html/export'

registry.register(htmlFormat)
```

### CLI 集成

```typescript
// packages/cli/src/commands/export.ts
// 只需在格式列表加入 'HTML'，已有的 IORegistry 自动路由
const EXPORT_FORMATS = ['PNG', 'JPG', 'WEBP', 'SVG', 'PDF', 'JSX', 'FIG', 'HTML']
```

---

## 四、核心实现细节

### 4.1 `IOFormatAdapter` 实现

```typescript
// packages/core/src/io/formats/html/export.ts
import type { IOFormatAdapter } from '#core/io/types'
import { renderNodesToHTML } from './index'

export interface HTMLExportOptions {
  mode?: 'inline-css' | 'tailwind-cdn'
  embedImages?: boolean          // 图片 fill 是否 base64 嵌入（默认 true）
  includeHidden?: boolean        // 是否包含不可见节点（默认 false）
  title?: string                 // <title> 标签内容
  viewport?: string              // <meta name="viewport"> 值
}

export const htmlFormat: IOFormatAdapter = {
  id: 'html',
  label: 'HTML',
  role: 'derived-export',
  category: 'code',
  mimeType: 'text/html',
  fileExtension: 'html',

  async exportContent(request, options: HTMLExportOptions = {}): Promise<ExportResult> {
    const { graph, target } = request
    const nodeIds = target.scope === 'selection'
      ? target.nodeIds
      : [target.nodeId ?? target.pageId]

    const html = renderNodesToHTML(graph, nodeIds, options)
    const bytes = new TextEncoder().encode(html)
    return { data: bytes, mimeType: 'text/html' }
  }
}
```

### 4.2 CSS 属性映射（`css.ts`）

这是最核心的模块，把 `SceneNode` 的每一个属性映射到对应的 CSS。

```typescript
// packages/core/src/io/formats/html/css.ts
import type { SceneNode, SceneGraph } from '#core/scene-graph'
import { collectFillsCSS } from './fills'
import { collectStrokesCSS } from './strokes'
import { collectEffectsCSS } from './effects'
import { collectLayoutCSS } from './layout'

export function nodeToCSS(
  node: SceneNode,
  graph: SceneGraph,
  opts: HTMLExportOptions
): Record<string, string> {
  const css: Record<string, string> = {}
  const parent = node.parentId ? graph.getNode(node.parentId) : null

  // 1. 尺寸与定位
  collectLayoutCSS(css, node, parent)

  // 2. 填充（背景）
  collectFillsCSS(css, node, graph, opts)

  // 3. 描边
  collectStrokesCSS(css, node)

  // 4. 圆角
  if (node.cornerRadius > 0) {
    if (node.independentCorners) {
      css.borderRadius = [
        node.topLeftRadius, node.topRightRadius,
        node.bottomRightRadius, node.bottomLeftRadius
      ].map(r => `${r}px`).join(' ')
    } else {
      css.borderRadius = node.cornerRadius >= 9999 ? '50%' : `${node.cornerRadius}px`
    }
  }

  // 5. 透明度与变换
  if (node.opacity < 1) css.opacity = String(node.opacity)
  if (node.rotation !== 0) css.transform = `rotate(${node.rotation}deg)`

  // 6. 裁剪
  if (node.clipsContent) css.overflow = 'hidden'

  // 7. 混合模式
  const blendMap: Record<string, string> = {
    MULTIPLY: 'multiply', SCREEN: 'screen', OVERLAY: 'overlay',
    DARKEN: 'darken', LIGHTEN: 'lighten', COLOR_DODGE: 'color-dodge',
    COLOR_BURN: 'color-burn', HARD_LIGHT: 'hard-light', SOFT_LIGHT: 'soft-light',
    DIFFERENCE: 'difference', EXCLUSION: 'exclusion', HUE: 'hue',
    SATURATION: 'saturation', COLOR: 'color', LUMINOSITY: 'luminosity'
  }
  if (blendMap[node.blendMode]) css.mixBlendMode = blendMap[node.blendMode]

  // 8. 特效
  collectEffectsCSS(css, node)

  return css
}

export function cssToString(css: Record<string, string>): string {
  return Object.entries(css)
    .map(([k, v]) => `${camelToKebab(k)}: ${v}`)
    .join('; ')
}

function camelToKebab(s: string): string {
  return s.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)
}
```

### 4.3 布局映射（`layout.ts`）

```typescript
// packages/core/src/io/formats/html/layout.ts
export function collectLayoutCSS(
  css: Record<string, string>,
  node: SceneNode,
  parent: SceneNode | null | undefined
): void {
  const parentIsAutoLayout = parent && parent.layoutMode !== 'NONE'

  if (parentIsAutoLayout) {
    // 子节点在 flex/grid 容器中，不需要绝对定位
    if (node.layoutGrow > 0) css.flexGrow = String(node.layoutGrow)
    if (node.layoutAlignSelf === 'STRETCH') css.alignSelf = 'stretch'
    // HUG → 由内容撑开，不设尺寸
    if (parent.layoutMode === 'HORIZONTAL') {
      if (node.primaryAxisSizing !== 'HUG') css.width = `${node.width}px`
      if (node.counterAxisSizing !== 'HUG') css.height = `${node.height}px`
    } else {
      if (node.counterAxisSizing !== 'HUG') css.width = `${node.width}px`
      if (node.primaryAxisSizing !== 'HUG') css.height = `${node.height}px`
    }
  } else {
    // 绝对定位（画布直接子节点，或 absolute 元素）
    css.position = 'absolute'
    css.left = `${node.x}px`
    css.top = `${node.y}px`
    css.width = `${node.width}px`
    css.height = `${node.height}px`
  }

  // Auto Layout 容器
  if (node.layoutMode === 'HORIZONTAL' || node.layoutMode === 'VERTICAL') {
    css.display = 'flex'
    if (node.layoutMode === 'VERTICAL') css.flexDirection = 'column'
    if (node.layoutWrap === 'WRAP') css.flexWrap = 'wrap'
    if (node.itemSpacing > 0) css.gap = `${node.itemSpacing}px`

    const justifyMap: Record<string, string> = {
      CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between'
    }
    const alignMap: Record<string, string> = {
      CENTER: 'center', MAX: 'flex-end', STRETCH: 'stretch'
    }
    if (justifyMap[node.primaryAxisAlign]) css.justifyContent = justifyMap[node.primaryAxisAlign]
    if (alignMap[node.counterAxisAlign]) css.alignItems = alignMap[node.counterAxisAlign]

    const { paddingTop: pt, paddingRight: pr, paddingBottom: pb, paddingLeft: pl } = node
    if (pt || pr || pb || pl) css.padding = `${pt}px ${pr}px ${pb}px ${pl}px`
  } else if (node.childIds.length > 0) {
    // Frame/Group 非 Auto Layout 时，子节点用 absolute，容器需 relative
    css.position = css.position === 'absolute' ? 'absolute' : 'relative'
  }

  // Grid 布局
  if (node.layoutMode === 'GRID') {
    css.display = 'grid'
    if (node.gridTemplateColumns.length > 0) {
      css.gridTemplateColumns = node.gridTemplateColumns
        .map(t => t.sizing === 'FR' ? `${t.value}fr` : t.sizing === 'FIXED' ? `${t.value}px` : 'auto')
        .join(' ')
    }
    if (node.gridTemplateRows.length > 0) {
      css.gridTemplateRows = node.gridTemplateRows
        .map(t => t.sizing === 'FR' ? `${t.value}fr` : t.sizing === 'FIXED' ? `${t.value}px` : 'auto')
        .join(' ')
    }
    if (node.gridColumnGap > 0) css.columnGap = `${node.gridColumnGap}px`
    if (node.gridRowGap > 0) css.rowGap = `${node.gridRowGap}px`
  }
}
```

### 4.4 填充映射（`fills.ts`）

```typescript
// packages/core/src/io/formats/html/fills.ts
import { colorToHex8 } from '#core/color'

export function collectFillsCSS(
  css: Record<string, string>,
  node: SceneNode,
  graph: SceneGraph,
  opts: HTMLExportOptions
): void {
  if (node.type === 'TEXT') return // 文本颜色在 text.ts 处理

  const visibleFills = node.fills.filter(f => f.visible)
  if (visibleFills.length === 0) return

  const backgrounds: string[] = []

  for (const fill of [...visibleFills].reverse()) { // CSS 背景层顺序与 Figma 相反
    switch (fill.type) {
      case 'SOLID': {
        const hex = colorToHex8(fill.color, fill.opacity)
        backgrounds.push(hex)
        break
      }
      case 'GRADIENT_LINEAR': {
        backgrounds.push(linearGradientCSS(fill))
        break
      }
      case 'GRADIENT_RADIAL': {
        backgrounds.push(radialGradientCSS(fill))
        break
      }
      case 'IMAGE': {
        if (opts.embedImages && fill.imageHash) {
          const imageData = graph.images.get(fill.imageHash)
          if (imageData) {
            const base64 = uint8ArrayToBase64(imageData)
            const mime = detectImageMime(imageData)
            backgrounds.push(`url("data:${mime};base64,${base64}")`)
            css.backgroundSize = scaleModeToCSS(fill.imageScaleMode ?? 'FILL')
            css.backgroundPosition = 'center'
            css.backgroundRepeat = 'no-repeat'
          }
        }
        break
      }
    }
  }

  if (backgrounds.length === 1) {
    css.background = backgrounds[0]
  } else if (backgrounds.length > 1) {
    css.background = backgrounds.join(', ')
  }
}

function linearGradientCSS(fill: Fill): string {
  const stops = fill.gradientStops
    ?.map(s => `${colorToHex8(s.color, s.color.a)} ${Math.round(s.position * 100)}%`)
    .join(', ') ?? ''
  const angle = gradientTransformToAngle(fill.gradientTransform)
  return `linear-gradient(${angle}deg, ${stops})`
}

function radialGradientCSS(fill: Fill): string {
  const stops = fill.gradientStops
    ?.map(s => `${colorToHex8(s.color, s.color.a)} ${Math.round(s.position * 100)}%`)
    .join(', ') ?? ''
  return `radial-gradient(ellipse at center, ${stops})`
}

function scaleModeToCSS(mode: string): string {
  const map: Record<string, string> = {
    FILL: 'cover', FIT: 'contain', TILE: 'auto', STRETCH: '100% 100%'
  }
  return map[mode] ?? 'cover'
}
```

### 4.5 特效映射（`effects.ts`）

```typescript
// packages/core/src/io/formats/html/effects.ts
import { colorToHex8 } from '#core/color'

export function collectEffectsCSS(
  css: Record<string, string>,
  node: SceneNode
): void {
  const shadows: string[] = []
  const filters: string[] = []
  const backdropFilters: string[] = []

  for (const e of node.effects) {
    if (!e.visible) continue
    switch (e.type) {
      case 'DROP_SHADOW': {
        const c = colorToHex8(e.color, e.color.a)
        const spread = e.spread ? ` ${e.spread}px` : ''
        shadows.push(`${e.offset.x}px ${e.offset.y}px ${e.radius}px${spread} ${c}`)
        break
      }
      case 'INNER_SHADOW': {
        const c = colorToHex8(e.color, e.color.a)
        const spread = e.spread ? ` ${e.spread}px` : ''
        shadows.push(`inset ${e.offset.x}px ${e.offset.y}px ${e.radius}px${spread} ${c}`)
        break
      }
      case 'LAYER_BLUR':
      case 'FOREGROUND_BLUR':
        filters.push(`blur(${e.radius}px)`)
        break
      case 'BACKGROUND_BLUR':
        backdropFilters.push(`blur(${e.radius}px)`)
        break
    }
  }

  if (shadows.length > 0) css.boxShadow = shadows.join(', ')
  if (filters.length > 0) css.filter = filters.join(' ')
  if (backdropFilters.length > 0) css.backdropFilter = backdropFilters.join(' ')
}
```

### 4.6 文本节点（`text.ts`）

```typescript
// packages/core/src/io/formats/html/text.ts
import { colorToHex8 } from '#core/color'

export function textNodeToHTML(
  node: SceneNode,
  graph: SceneGraph
): { tag: string; css: Record<string, string>; content: string } {
  const css: Record<string, string> = {}

  // 字体样式
  if (node.fontSize) css.fontSize = `${node.fontSize}px`
  if (node.fontFamily) css.fontFamily = `"${node.fontFamily}", sans-serif`
  if (node.fontWeight && node.fontWeight !== 400) css.fontWeight = String(node.fontWeight)
  if (node.italic) css.fontStyle = 'italic'

  // 对齐
  const alignMap: Record<string, string> = { CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' }
  if (alignMap[node.textAlignHorizontal]) css.textAlign = alignMap[node.textAlignHorizontal]

  // 行高、字距
  if (node.lineHeight != null) css.lineHeight = `${node.lineHeight}px`
  if (node.letterSpacing !== 0) css.letterSpacing = `${node.letterSpacing}px`

  // 文字装饰
  const decorMap: Record<string, string> = { UNDERLINE: 'underline', STRIKETHROUGH: 'line-through' }
  if (decorMap[node.textDecoration]) css.textDecoration = decorMap[node.textDecoration]

  // 文字变换
  const caseMap: Record<string, string> = {
    UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize'
  }
  if (caseMap[node.textCase]) css.textTransform = caseMap[node.textCase]

  // 截断
  if (node.textTruncation === 'ENDING') {
    css.overflow = 'hidden'
    css.textOverflow = 'ellipsis'
    css.whiteSpace = 'nowrap'
  }

  // 颜色（取第一个可见 SOLID fill）
  const solidFill = node.fills.find(f => f.visible && f.type === 'SOLID')
  if (solidFill) css.color = colorToHex8(solidFill.color, solidFill.opacity)

  // 语义标签推断
  const tag = node.fontSize >= 24 ? 'h2' : node.fontSize >= 18 ? 'h3' : 'p'

  // 富文本（styleRuns）→ 用 <span> 包裹不同样式段落
  const content = buildTextContent(node)

  return { tag, css, content }
}

function buildTextContent(node: SceneNode): string {
  const text = node.text ?? ''
  if (!node.styleRuns || node.styleRuns.length === 0) {
    return escapeHTML(text)
  }
  // 把 styleRuns 转换为 <span style="..."> 包裹
  let result = ''
  let cursor = 0
  for (const run of node.styleRuns) {
    const runText = text.slice(cursor, cursor + run.length)
    cursor += run.length
    if (Object.keys(run.style).length === 0) {
      result += escapeHTML(runText)
    } else {
      const spanCSS = styleRunToCSS(run.style)
      result += `<span style="${spanCSS}">${escapeHTML(runText)}</span>`
    }
  }
  return result + escapeHTML(text.slice(cursor))
}

function escapeHTML(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
}
```

### 4.7 节点树递归（`node.ts`）

```typescript
// packages/core/src/io/formats/html/node.ts
import type { SceneGraph, SceneNode } from '#core/scene-graph'
import { nodeToCSS, cssToString } from './css'
import { textNodeToHTML } from './text'

// Figma 节点类型 → HTML 语义标签
const SEMANTIC_TAGS: Partial<Record<string, string>> = {
  FRAME: 'div',
  RECTANGLE: 'div',
  ROUNDED_RECTANGLE: 'div',
  ELLIPSE: 'div',
  GROUP: 'div',
  COMPONENT: 'div',
  COMPONENT_SET: 'div',
  INSTANCE: 'div',
  SECTION: 'section',
  TEXT: 'p',
  LINE: 'hr',
  STAR: 'div',
  POLYGON: 'div',
  VECTOR: 'div',  // 矢量节点 → 嵌 SVG（见下）
  BOOLEAN_OPERATION: 'div',
}

export function nodeToHTMLString(
  node: SceneNode,
  graph: SceneGraph,
  opts: HTMLExportOptions,
  indent = 0
): string {
  if (!node.visible && !opts.includeHidden) return ''

  const pad = '  '.repeat(indent)

  // 矢量节点特殊处理：输出内嵌 SVG
  if (shouldEmbedAsSVG(node)) {
    return vectorNodeToInlineSVG(node, graph, indent)
  }

  // 文本节点
  if (node.type === 'TEXT') {
    const { tag, css, content } = textNodeToHTML(node, graph)
    const layoutCSS = nodeToCSS(node, graph, opts)
    const merged = { ...layoutCSS, ...css }
    const style = cssToString(merged)
    const dataName = node.name ? ` data-name="${escapeAttr(node.name)}"` : ''
    return `${pad}<${tag}${dataName} style="${style}">${content}</${tag}>`
  }

  const tag = SEMANTIC_TAGS[node.type] ?? 'div'
  const css = nodeToCSS(node, graph, opts)
  const style = cssToString(css)
  const dataName = node.name ? ` data-name="${escapeAttr(node.name)}"` : ''
  const opening = `${pad}<${tag}${dataName} style="${style}">`

  // 叶节点
  const visibleChildren = node.childIds
    .map(id => graph.getNode(id))
    .filter((c): c is SceneNode => !!c && (c.visible || !!opts.includeHidden))

  if (visibleChildren.length === 0) {
    return `${pad}<${tag}${dataName} style="${style}" />`
  }

  const childrenHTML = visibleChildren
    .map(child => nodeToHTMLString(child, graph, opts, indent + 1))
    .filter(Boolean)
    .join('\n')

  return `${opening}\n${childrenHTML}\n${pad}</${tag}>`
}

function shouldEmbedAsSVG(node: SceneNode): boolean {
  return (
    node.type === 'VECTOR' ||
    node.type === 'BOOLEAN_OPERATION' ||
    node.type === 'STAR' ||
    node.type === 'POLYGON' ||
    node.type === 'ELLIPSE' ||
    node.type === 'LINE'
  )
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
```

### 4.8 矢量节点嵌 SVG

矢量形状（VECTOR、BOOLEAN_OPERATION、STAR、POLYGON、ELLIPSE）直接复用已有 SVG 导出模块，作为 `<svg>` 标签内嵌在 HTML 中：

```typescript
// packages/core/src/io/formats/html/node.ts（续）
import { renderSVGNode } from '#core/io/formats/svg/node'
import { renderSVGNode as renderSVGNodeFn } from '#core/io/formats/svg/export'

function vectorNodeToInlineSVG(
  node: SceneNode,
  graph: SceneGraph,
  indent: number
): string {
  // 复用 SVG 导出模块生成 SVG 片段
  const { renderNodesToSVG } = require('#core/io/formats/svg')
  const svgString = renderNodesToSVG(graph, node.parentId ?? '', [node.id])
  if (!svgString) return ''

  const pad = '  '.repeat(indent)
  const css = nodeToCSS(node, graph, {})
  css.position = css.position ?? 'absolute'
  const style = cssToString(css)
  const dataName = node.name ? ` data-name="${escapeAttr(node.name)}"` : ''

  // 把 SVG 包裹在 div 容器里，保持定位正确
  return `${pad}<div${dataName} style="${style}">\n${pad}  ${svgString}\n${pad}</div>`
}
```

### 4.9 文档模板（`template.ts`）

```typescript
// packages/core/src/io/formats/html/template.ts
export interface HTMLDocumentOptions {
  title?: string
  viewport?: string
  mode?: 'inline-css' | 'tailwind-cdn'
  bodyStyle?: string
}

export function wrapHTMLDocument(
  bodyContent: string,
  opts: HTMLDocumentOptions = {}
): string {
  const title = opts.title ?? 'OpenPencil Export'
  const viewport = opts.viewport ?? 'width=device-width, initial-scale=1.0'
  const bodyStyle = opts.bodyStyle ?? 'margin: 0; padding: 0; position: relative;'

  const tailwindScript = opts.mode === 'tailwind-cdn'
    ? '\n  <script src="https://cdn.tailwindcss.com"></script>'
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="${viewport}">
  <title>${title}</title>${tailwindScript}
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { ${bodyStyle} }
  </style>
</head>
<body>
${bodyContent}
</body>
</html>`
}
```

### 4.10 主入口（`index.ts`）

```typescript
// packages/core/src/io/formats/html/index.ts
import type { SceneGraph } from '#core/scene-graph'
import { nodeToHTMLString } from './node'
import { wrapHTMLDocument } from './template'
import type { HTMLExportOptions } from './export'

export function renderNodesToHTML(
  graph: SceneGraph,
  nodeIds: string[],
  opts: HTMLExportOptions = {}
): string {
  const bodyContent = nodeIds
    .map(id => {
      const node = graph.getNode(id)
      return node ? nodeToHTMLString(node, graph, opts, 1) : ''
    })
    .filter(Boolean)
    .join('\n\n')

  const firstNode = nodeIds.map(id => graph.getNode(id)).find(Boolean)
  const title = opts.title ?? firstNode?.name ?? 'OpenPencil Export'

  return wrapHTMLDocument(bodyContent, {
    title,
    viewport: opts.viewport,
    mode: opts.mode,
  })
}
```

---

## 五、CLI 使用方式

实现后，CLI 命令格式如下：

```bash
# 基本导出（内联 CSS，默认）
bun open-pencil export design.fig --format HTML --output ./dist/index.html

# 指定节点 ID 导出
bun open-pencil export design.fig --format HTML --id 0:56 --output ./page.html

# Tailwind CDN 模式
bun open-pencil export design.fig --format HTML --style tailwind --output ./index.html

# 导出所有页面（每页一个文件）
bun open-pencil export design.fig --format HTML --all-pages --output ./dist/

# 不嵌入图片（图片 fill 留空）
bun open-pencil export design.fig --format HTML --no-embed-images --output ./index.html
```

---

## 六、MCP 工具集成

在 `packages/core/src/tools/vector/export.ts` 中新增 `export_html` 工具：

```typescript
export const exportHtml = defineTool({
  name: 'export_html',
  description: 'Export nodes as a self-contained HTML file with inline CSS styles.',
  mutates: false,
  params: {
    ids: { type: 'string[]', description: 'Node IDs to export. Defaults to page root.' },
    mode: {
      type: 'string',
      description: 'Output mode: "inline-css" (default) or "tailwind-cdn"',
      default: 'inline-css'
    },
    embed_images: {
      type: 'boolean',
      description: 'Embed image fills as base64 data URIs',
      default: true
    },
    path: { type: 'string', description: 'Write output to this file path (requires OPENPENCIL_MCP_ROOT)' }
  },
  execute: async (figma, args) => {
    const { renderNodesToHTML } = await import('#core/io/formats/html')
    const ids = args.ids?.length ? args.ids : [figma.currentPage.id]
    const html = renderNodesToHTML(figma.graph, ids, {
      mode: args.mode as 'inline-css' | 'tailwind-cdn',
      embedImages: args.embed_images ?? true
    })
    return { html, byteLength: html.length }
  }
})
```

在 `packages/core/src/tools/registry.ts` 中加入 `exportHtml`：

```typescript
export const ALL_TOOLS: ToolDef[] = [
  // ...existing tools...
  exportHtml,
]
```

---

## 七、功能覆盖范围与限制

### ✅ 方案 A 支持的属性

| 分类 | 支持的属性 |
|---|---|
| **布局** | 绝对定位、flexbox（行/列/换行/对齐/间距）、CSS Grid、padding |
| **尺寸** | 固定宽高、fill（100%）、HUG（由内容撑开） |
| **背景** | 纯色、线性渐变、径向渐变、图片（base64 嵌入） |
| **描边** | 纯色描边、粗细、圆角 |
| **圆角** | 统一圆角、独立四角圆角 |
| **特效** | Drop shadow、inner shadow、layer blur、backdrop blur |
| **文本** | 字体族、字号、字重、颜色、对齐、行高、字距、装饰、变换、截断 |
| **变换** | 旋转（rotation）、opacity |
| **混合模式** | 所有标准 CSS mix-blend-mode 值 |
| **裁剪** | `overflow: hidden` |
| **矢量** | STAR、POLYGON、ELLIPSE、VECTOR、BOOLEAN_OPERATION → 内嵌 SVG |
| **图片节点** | 通过 IMAGE fill base64 嵌入 |

### ⚠️ 已知限制

| 限制 | 原因 | 处理方式 |
|---|---|---|
| **角度描边**（非矩形的 OUTSIDE/INSIDE） | CSS 无法精确对齐描边位置 | 降级为 box-shadow 模拟 |
| **渐变描边** | CSS 无原生支持 | 降级纯色或跳过 |
| **视频 fill** | HTML 可以支持，但需要 URL | 当前版本跳过 |
| **Noise/Pattern fill** | 无 CSS 等价 | 跳过 |
| **cornerSmoothing（苹果圆角）** | CSS `border-radius` 无法精确还原 | 使用近似 border-radius |
| **多个 fill 叠加**（非 SOLID） | CSS background 层叠顺序有差异 | 尽力模拟 |
| **旋转子节点内的布局** | CSS transform 不参与流式布局 | 输出 transform，视觉近似 |
| **复杂富文本**（字间距 per-character） | CSS 粒度不够细 | 展开成多个 `<span>` |

---

## 八、工作量评估

| 模块 | 工作量 | 依赖 |
|---|---|---|
| `css.ts` + `layout.ts` | 1.5 天 | 无 |
| `fills.ts`（含渐变） | 1 天 | 无 |
| `strokes.ts` + `effects.ts` | 0.5 天 | 无 |
| `text.ts`（含 styleRuns） | 1 天 | 无 |
| `node.ts` 递归树遍历 + SVG 内嵌 | 1 天 | SVG 导出模块 |
| `template.ts` + `export.ts` + `index.ts` | 0.5 天 | 无 |
| CLI 集成（export.ts 加一行） | 0.25 天 | 无 |
| MCP 工具（export_html） | 0.5 天 | 无 |
| 测试（Playwright canvas 对比 / 单元测试） | 1.5 天 | 无 |
| **合计** | **~8 人天** | |

---

## 九、实施路径建议

### Phase 1（MVP，3 天）

1. 实现 `css.ts` / `layout.ts` / `fills.ts`（仅 SOLID）/ `effects.ts` / `text.ts`（单样式）
2. 实现 `node.ts` 树遍历 + `template.ts`
3. 注册 `htmlFormat` 到 `IORegistry`
4. CLI 支持 `--format HTML`
5. 验证：能导出简单的 Frame + Text + Rectangle 布局

### Phase 2（完善，3 天）

1. `fills.ts` 支持渐变、图片 base64 嵌入
2. `text.ts` 支持 `styleRuns` 富文本展开
3. 矢量节点 → 内嵌 SVG
4. 追加 MCP `export_html` 工具
5. Playwright 截图对比测试

### Phase 3（打磨，2 天）

1. Tailwind CDN 模式（方案 B）
2. `--all-pages` 批量导出 + 页面间导航链接
3. 响应式模式（Frame 以 `max-width` 居中而非 `position: absolute`）
4. 文档与 CHANGELOG 更新

---

## 十、参考现有代码位置

| 要复用 / 参考的逻辑 | 文件位置 |
|---|---|
| `IOFormatAdapter` 接口定义 | `packages/core/src/io/types.ts` |
| 注册现有格式的方式 | `packages/core/src/io/formats.ts` |
| 颜色转 hex 工具 | `packages/core/src/color/index.ts` → `colorToHex8` |
| 渐变变换矩阵计算 | `packages/core/src/io/formats/svg/defs.ts` → `gradientTransformToAngle` |
| 矢量节点 SVG 生成 | `packages/core/src/io/formats/svg/export.ts` |
| 图片 fill 获取 | `graph.images: Map<string, Uint8Array>` |
| SceneNode 类型定义 | `packages/core/src/scene-graph/types.ts` |
| CLI 导出命令 | `packages/cli/src/commands/export.ts` |
| MCP 工具 export 定义 | `packages/core/src/tools/vector/export.ts` |
