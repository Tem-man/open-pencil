# 韩语（Hangul）字体显示修复计划

> 项目：`D:\AI\open-pencil`  
> 状态：草案（未实施）  
> 关联：中文 CJK 回退已在 `fix-chinese-font-bug` 分支通过 bundled `Noto Sans SC` 修复

---

## 1. 背景与目标

### 1.1 问题

当前内置回退字体为 **Noto Sans SC 子集**（`public/NotoSansSC-Regular.woff2`），主要覆盖简体汉字。韩语使用 **Hangul 音节块**（U+AC00–U+D7AF），与汉字区不重叠：

- 检测层：`CJK_RE` 已包含 `\uac00-\ud7af`，韩文会触发 CJK 回退逻辑
- 就绪判断：只要 `cjkFallbackFamilies.length > 0`（例如 SC 加载成功）即视为「CJK 已就绪」
- 别名注册：SC 字体会被注册为 `Noto Sans KR`、`Malgun Gothic` 等别名

结果是：**系统认为韩语字体已就绪，但实际 glyph 来自 SC 子集，Hangul 仍可能显示为 tofu（NO GLYPH）**。

E2E 测试 `tests/e2e/text/hangul-editing.spec.ts` 仅验证输入/提交与段落不报错，**未做像素级字形断言**；在 stub Google Fonts 环境下更容易掩盖渲染问题。

### 1.2 目标

| 目标 | 说明 |
|------|------|
| G1 | 纯韩文、韩英混排、中韩混排在无本地字体、无 Google Fonts 时稳定显示 |
| G2 | 不破坏现有中文回退与竞态修复（prefetch / `isNodeFontLoaded` 门禁） |
| G3 | 控制 bundled 体积增量（单 KR 子集约 +1–1.5 MB） |
| G4 | 为日文（Kana）留出相同扩展点（可选同期做，见 §6） |

### 1.3 非目标

- 不引入完整 **Noto Sans CJK** 全量包（15MB+）
- 不重构整个 `FontManager` 为通用 i18n 字体服务
- 不处理 RTL、阿拉伯文（已有独立 `arabic` 回退链）

---

## 2. 现状架构（简要）

```
main.ts
  └─ prefetchBundledCJKFont()          # 仅下载 SC

loadFonts()
  └─ attachProvider() → applyBundledIfReady()
  └─ onCJKFallbackLoaded → invalidateAllPictures()
  └─ void ensureCJKFallback()

FontCJKFallback (cjk-fallback.ts)
  1. tryBundledFonts()     → Noto Sans SC only
  2. tryLocalFonts()       → 含 Malgun Gothic / Apple SD Gothic Neo
  3. tryGoogleFonts()      → Noto Sans KR 等（国内常失败）

canvas/text.ts
  └─ CJK_RE 检测 + hasRequiredFallbackFonts()
  └─ buildParagraph() 追加 cjkFallbackFamilies

editor/text.ts
  └─ ensureCJKFallback() 后再 te.start()
```

**关键缺陷**：回退链按「脚本无关」的单列表 `cjkFallbackFamilies` 运作，且 bundled 仅 SC。

---

## 3. 根因总结

| # | 根因 | 影响 |
|---|------|------|
| R1 | Bundled 只有 SC，无 KR glyph | 韩文 tofu |
| R2 | SC 注册为 KR 别名 | Skia 选中错误 typeface |
| R3 | `hasRequiredFallbackFonts` 不区分脚本 | SC 加载后韩文提前渲染 |
| R4 | `ensureCJKFallback` 一次成功即短路 | 不会继续加载 KR |
| R5 | 本地韩文字体需 `queryLocalFonts` 授权 | 与中文相同的不稳定因素 |

---

## 4. 方案选型

### 方案 A（推荐）：按脚本拆分 bundled + 就绪检测

将「CJK 回退」细化为 **East Asian 多脚本回退**，每种脚本有独立 bundled 与别名表。

```
脚本          检测 Unicode              Bundled 字体           别名示例
─────────────────────────────────────────────────────────────────────────
Han (中文)    \u4e00-\u9fff 等          Noto Sans SC           微软雅黑、PingFang SC
Hangul (韩)   \uac00-\ud7af            Noto Sans KR           Malgun Gothic、Apple SD Gothic Neo
Kana (日)     \u3040-\u30ff 等         Noto Sans JP（可选）    Hiragino Sans、Yu Gothic
```

**优点**：体积可控、与现有 `FontCJKFallback` 模式一致、可渐进交付（先 KR，后 JP）。  
**缺点**：需改 readiness 与别名逻辑，涉及文件略多。

### 方案 B：单一 Noto Sans CJK KR/SC/JP 合并子集

自定义 subset，一个 woff2 覆盖三国。  
**优点**：一次加载。 **缺点**：subset 工具链复杂、体积难控、维护成本高。**不推荐**。

### 方案 C：仅依赖 Google Fonts 拉取 Noto Sans KR

**不推荐**：与中文修复动机相同（国内不可用、竞态、无用户激活）。

**结论：采用方案 A，第一期只做 Hangul（KR），架构预留 Kana。**

---

## 5. 详细设计

### 5.1 脚本检测（`packages/core/src/text/script.ts`，新文件）

```ts
export type EastAsianScript = 'han' | 'hangul' | 'kana'

export function detectEastAsianScripts(text: string): Set<EastAsianScript>
export function textNeedsHan(text: string): boolean
export function textNeedsHangul(text: string): boolean
export function textNeedsKana(text: string): boolean
```

从 `canvas/text.ts` 的 `CJK_RE` 拆出：

- `HANGUL_RE = /\uac00-\ud7af/u`
- `KANA_RE = /\u3040-\u30ff/u`（必要时加 `\u31f0-\u31ff`）
- `HAN_RE` = 原 CJK 汉字区（去掉 Hangul/Kana 已覆盖范围）

### 5.2 回退清单（`packages/core/src/constants.ts` + `fallbacks.ts`）

为每种脚本定义 **local** / **remote** / **bundled** 三元组：

```ts
export const HANGUL_LOCAL_FAMILIES_WINDOWS = ['Malgun Gothic', 'Malgun Gothic Semilight', ...]
export const HANGUL_LOCAL_FAMILIES_MACOS = ['Apple SD Gothic Neo', ...]
export const HANGUL_REMOTE_FAMILIES = ['Noto Sans KR']
export const BUNDLED_HANGUL_FAMILY = 'Noto Sans KR'
export const BUNDLED_HANGUL_URL = '/NotoSansKR-Regular.woff2'
```

`fontFallbackManifest` 扩展：

```ts
export type FontFallbackScript = 'han' | 'hangul' | 'kana' | 'arabic'
// 或保留 'cjk' 作为聚合，内部再分脚本
```

**别名注册规则（重要）**：

- SC buffer **只** alias 中文相关 family（`CJK_GOOGLE_FONTS` 中的 SC + 中文系统字体）
- KR buffer **只** alias `Noto Sans KR` + 韩文系统字体
- **禁止** 用 SC 文件注册 `Noto Sans KR` / `Malgun Gothic`

### 5.3 重构 `cjk-fallback.ts` → `east-asian-fallback.ts`

将 `FontCJKFallback` 泛化为 `FontEastAsianFallback`（或保留类名、内部多 bundled）：

| 能力 | 行为 |
|------|------|
| `prefetch()` | 并行 prefetch SC + KR（JP 可 lazy） |
| `ensure()` | 根据文档/当前编辑文本需要的脚本，加载对应 bundled |
| `getReadyFamilies()` | 返回已就绪 family 列表（供 paragraph fallback） |
| `isScriptReady(script)` | 供 `hasRequiredFallbackFonts` 细查 |
| 竞态 | 延续现有：`!fontProvider` 不缓存失败 Promise；单例 fetch；`onLoaded` Set |

加载顺序（每个脚本独立）：

1. Bundled（最可靠）
2. Local（跳过已 alias 的 family）
3. Google remote

### 5.4 就绪检测（`canvas/text.ts`）

替换 `hasRequiredFallbackFonts`：

```ts
function hasRequiredFallbackFonts(text: string): boolean {
  if (textNeedsHangul(text) && !fontManager.isHangulFallbackReady()) return false
  if (textNeedsHan(text) && !fontManager.isHanFallbackReady()) return false
  if (textNeedsKana(text) && !fontManager.isKanaFallbackReady()) return false
  if (ARABIC_RE.test(text) && !fontManager.getArabicFallbackFamilies().length) return false
  return true
}
```

`ensureCJKFallbackForText` 改名为 `ensureEastAsianFallbackForText`，内部按脚本调用 `ensureHangulFallback()` 等。

### 5.5 Paragraph 回退链（`buildParagraph`）

`cjkFallbacks` 改为按文本内容合并：

```ts
const fallbacks = fontManager.getEastAsianFallbackFamiliesForText(node.text)
// 例如含韩文时 prepend Noto Sans KR，含中文时 prepend Noto Sans SC
```

避免把所有脚本 family 无差别塞进每条文本（减少错误 fallback 顺序）。

### 5.6 资源文件

| 路径 | 说明 |
|------|------|
| `public/NotoSansKR-Regular.woff2` | 浏览器 dev / 部署静态资源 |
| `packages/core/assets/NotoSansKR-Regular.woff2` | headless CLI / 单元测试 |
| `packages/core/src/text/fonts.ts` `BUNDLED_FONTS` | 增加 `'Noto Sans KR\|Regular'` 条目 |

**字体来源建议**：`@fontsource/noto-sans-kr` 的 korean 子集 woff2（与 SC 相同策略），目标体积 ~1–1.5 MB。

### 5.7 应用入口

`src/main.ts`：

```ts
fontManager.prefetchEastAsianFonts()
// 或 prefetchBundledCJKFont() 扩展为 prefetch SC + KR
```

### 5.8 文本编辑（`editor/text.ts`）

进入编辑前：

```ts
await fontManager.ensureFallbacksForText(node.text)
// 对空文本：prefetch 全部常见脚本，或 ensure 全包
```

避免只 `ensureCJKFallback()` 而韩文未加载。

### 5.9 导出 / headless

`prepareForExport` 在 `collectFontKeys` 之外，对图中所有 TEXT 节点扫描脚本并 `ensureHangulFallback()` 等，保证 CLI 导出 PNG 含韩文。

---

## 6. 实施阶段

### Phase 1 — Hangul 最小可用（推荐先做）

1. 添加 `NotoSansKR-Regular.woff2` 资源
2. 新增 `script.ts` 检测与 `isHangulFallbackReady()`
3. 扩展 `FontCJKFallback`：第二套 bundled KR + 分离别名
4. 修复 `hasRequiredFallbackFonts` / `ensureCJKFallbackForText`
5. 单元测试 + 视觉/E2E 断言
6. `CHANGELOG.md` Unreleased

**预估改动**：~8–12 个文件，+1.2 MB 资源。

### Phase 2 — 日文 Kana（可选）

- 同样模式添加 `NotoSansJP-Regular.woff2`
- `textNeedsKana` + `isKanaFallbackReady`
- 别名仅日文字体名

### Phase 3 — 清理与命名（可选）

- `CJK_*` 常量重命名为 `EAST_ASIAN_*` / `HAN_*` / `HANGUL_*`
- `ensureCJKFallback` 保留为 deprecated 包装
- 文档更新 `AGENTS.md` Rendering 小节

---

## 7. 文件变更清单（Phase 1）

| 文件 | 变更 |
|------|------|
| `public/NotoSansKR-Regular.woff2` | 新增 |
| `packages/core/assets/NotoSansKR-Regular.woff2` | 新增 |
| `packages/core/src/text/script.ts` | 新增：脚本检测 |
| `packages/core/src/text/cjk-fallback.ts` | 扩展 KR bundled；拆分别名 |
| `packages/core/src/text/fallbacks.ts` | 增加 hangul manifest |
| `packages/core/src/constants.ts` | 韩文 local/remote 常量 |
| `packages/core/src/text/fonts.ts` | BUNDLED_FONTS、ready API、`ensureHangulFallback` |
| `packages/core/src/canvas/text.ts` | 分脚本 readiness + fallback 链 |
| `packages/core/src/canvas/scene.ts` | `ensureEastAsianFallbackForText` |
| `packages/core/src/editor/text.ts` | 按节点文本 ensure |
| `src/main.ts` | prefetch KR |
| `tests/engine/text/fonts/loading.test.ts` | fetch bundled KR |
| `tests/engine/text/script.test.ts` | 新增脚本检测测试 |
| `tests/e2e/fonts/hangul-render.spec.ts` | 新增：stub 本地/Google 后像素或 paragraph 宽度断言 |
| `CHANGELOG.md` | 记录修复 |

---

## 8. 测试计划

### 8.1 单元测试

- `detectEastAsianScripts('안녕')` → `{ hangul }`
- `detectEastAsianScripts('你好')` → `{ han }`
- `detectEastAsianScripts('안녕你好')` → `{ hangul, han }`
- `fetchBundledFont('/NotoSansKR-Regular.woff2')` headless 可读
- CanvasKit `Paragraph` 对 `환경설정` 的 `getLongestLine() > 0` 且无 tofu 占位宽度异常

### 8.2 E2E

在 `hangul-editing.spec.ts` 同级增加 **渲染** 用例：

1. stub `queryLocalFonts` + Google Fonts（与现有一致）
2. 创建含 `한글 테스트` 的 TEXT 节点
3. 断言 `renderer.isNodeFontLoaded(node) === true`
4. 断言 `paragraph.getLongestLine()` 大于仅 Inter 时的宽度（或 screenshot 回归）

### 8.3 手动验证

- [ ] 硬刷新后输入纯韩文
- [ ] 中韩混排 `你好한글`
- [ ] 打开含韩文的 .fig
- [ ] 断网 + 拒绝本地字体权限
- [ ] Tauri 桌面与浏览器各测一次

---

## 9. 竞态条件（必须保留）

韩语修复应 **复用** 中文已实现的防护，不要引入新竞态：

| 规则 | 说明 |
|------|------|
| prefetch 与 ensure 分离 | `main.ts` 只 prefetch，不提前 ensure |
| `!fontProvider` 不缓存失败 | 每个脚本的 ensure Promise 均如此 |
| `isNodeFontLoaded` 门禁 | 脚本未 ready 时不绘制、不缓存 picture |
| 单例 `bundledFetch` | SC 与 KR 各一个 Promise，可并行 |
| `onCJKFallbackLoaded` / 重绘 | 任一脚本就绪后 `invalidateAllPictures()` |
| 别名不覆盖 | 本地字体不覆盖已注册 bundled 别名 |

**注意**：拆脚本后，`cjkFallbackFamilies.length > 0` 不能作为韩文就绪条件，必须改为 `isHangulFallbackReady()`。

---

## 10. 体积与性能

| 项 | 估算 |
|----|------|
| 现有 SC woff2 | ~1.1 MB |
| 新增 KR woff2 | ~1.0–1.5 MB |
| 首次加载 | prefetch 并行，不阻塞 `fontsLoaded` |
| 内存 | 每个 bundled 一份 `ArrayBuffer` + CanvasKit 注册 |

若体积敏感，可对 KR 使用 **korean syllables only** 子集（不含拉丁），与 SC 策略一致。

---

## 11. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 混排文本 fallback 顺序错误 | `getEastAsianFallbackFamiliesForText` 按检测顺序 prepend |
| 重复加载导致 jscpd / max-lines | 抽 `BundledScriptFallback` 小类，SC/KR 各一实例 |
| 旧 API `ensureCJKFallback` 被外部调用 | 保留包装，内部 ensure 全部所需脚本 |
| fixture .fig 韩文字体名与 bundled 不一致 | 别名表覆盖 `Noto Sans KR` 及常见系统名 |

---

## 12. 验收标准

1. 在 **无本地字体、无 Google** 环境下，韩文不出现 NO GLYPH
2. 中文修复行为不退化（现有 CJK E2E 仍通过）
3. `bun run check` 全绿（含 `test:dupes`、单元、E2E）
4. bundled 总体积增量 documented in CHANGELOG

---

## 13. 参考

- 现有实现：`packages/core/src/text/cjk-fallback.ts`
- 中文修复分支：`fix-chinese-font-bug`
- 韩文 E2E（输入）：`tests/e2e/text/hangul-editing.spec.ts`
- Unicode：Hangul Syllables U+AC00–U+D7AF
