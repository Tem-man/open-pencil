# AI 驱动的交互原型功能实现方案

> 聚焦场景：**AI 生成可交互设计稿**。不涉及从 Figma 导入原型数据的兼容性问题，只考虑 AI 从零创建带有交互跳转的原型稿，以及用户在浏览器中直接演示。

---

## 一、可行性结论

**技术上非常可行，且与现有架构天然契合，改动成本远低于通用原型系统。**

核心洞察：**AI 已经通过 `render` 工具 + JSX props 来控制设计稿的全部视觉属性**（颜色、布局、字体、特效）。给 JSX 新增几个交互 props（`onClick`、`onHover`、`afterDelay`），就能让 AI 在一次 `render` 调用中同时完成视觉设计和交互连线，无需任何额外工具调用。

```jsx
{/* AI 生成的一次 render 调用，同时包含视觉和交互 */}
<Frame name="LoginScreen" w={390} h={844} bg="#F5F5F5">
  <Frame name="LoginBtn" w="fill" h={48} bg="#007AFF" rounded={12}
    onClick={{ navigate: "HomeScreen", transition: "slide-left", duration: 300 }}>
    <Text color="white" weight="bold">登录</Text>
  </Frame>
</Frame>

<Frame name="HomeScreen" w={390} h={844} bg="#fff" x={410}>
  {/* 主页内容... */}
</Frame>
```

---

## 二、整体架构

### 数据流

```
AI system-prompt 教会 AI 交互 props 语法
          │
          ▼
AI 调用 render 工具，JSX 中包含 onClick / onHover / afterDelay
          │
          ▼
design-jsx: propsToOverrides() 解析交互 props → Reaction[]
          │  (新增解析分支，无需改 renderer.ts)
          ▼
graph.createNode() 时 SceneNode.reactions 已就位
          │
          ▼  requestRender() 后，Canvas 正常显示设计稿
          │
   用户点击"演示"按钮
          │
          ▼
PresentView.vue (新增路由 /present)
          │
          ▼
PrototypeEngine: 命中测试 → 匹配 Reaction → 更新 PresentState
          │
          ▼
CSS 过渡动画 / SkiaRenderer 渲染目标帧
```

### 新增文件（最小化改动）

```
packages/core/src/
├── prototype/
│   ├── types.ts          ← Reaction / Action / PresentState 类型
│   ├── engine.ts         ← 原型运行时状态机（纯函数，不可变）
│   └── transitions.ts    ← 过渡动画参数计算
├── scene-graph/
│   └── types.ts          ← SceneNode 新增 reactions 字段（共 2 行）
├── design-jsx/
│   └── props-overrides.ts ← 新增 applyReactionOverrides() 分支
└── editor/
    └── types.ts          ← EditorState 新增 presentMode / presentState

src/
├── router.ts             ← 新增 /present 路由（共 4 行）
├── views/
│   └── PresentView.vue   ← 全屏演示视图（新建）
└── components/prototype/
    ├── PrototypeFrame.vue ← 单帧渲染容器
    ├── PrototypeOverlay.vue ← Overlay 帧容器
    └── PrototypeToolbar.vue ← 返回编辑 / 切换流程按钮
```

---

## 三、JSX 交互语法设计

### 3.1 核心原则

- **对 AI 友好**：语法尽量接近 React 事件处理的直觉
- **内联完备**：一个 JSX prop 描述完整的触发器 + 动作 + 动画参数
- **不破坏现有 props**：交互 props 单独解析，不影响现有视觉属性

### 3.2 完整语法规范

```jsx
{
  /* ===== 基础导航 ===== */
}

{
  /* 点击跳转（最常用） */
}
;<Frame name="LoginBtn" onClick={{ navigate: 'HomeScreen' }} />

{
  /* 指定过渡动画 */
}
;<Frame
  name="LoginBtn"
  onClick={{ navigate: 'HomeScreen', transition: 'slide-left', duration: 300 }}
/>

{
  /* 悬停跳转 */
}
;<Frame name="Card" onHover={{ navigate: 'DetailScreen', transition: 'dissolve', duration: 200 }} />

{
  /* 悬停离开 */
}
;<Frame name="Card" onHoverEnd={{ navigate: 'ListScreen', transition: 'dissolve' }} />

{
  /* 定时自动跳转（启动页、引导页） */
}
;<Frame
  name="SplashScreen"
  afterDelay={2000}
  do={{ navigate: 'HomeScreen', transition: 'fade', duration: 400 }}
/>

{
  /* ===== 导航动作 ===== */
}

{
  /* 返回上一帧 */
}
;<Frame name="BackBtn" onClick={{ back: true }} />

{
  /* 打开 Overlay（弹出层） */
}
;<Frame
  name="MenuBtn"
  onClick={{ overlay: 'MenuPanel', position: 'bottom', closeOnBackdrop: true }}
/>

{
  /* 关闭当前 Overlay */
}
;<Frame name="CloseBtn" onClick={{ close: true }} />

{
  /* 打开外部链接 */
}
;<Frame name="LinkBtn" onClick={{ url: 'https://example.com', newTab: true }} />

{
  /* ===== 过渡类型 ===== */
}
{
  /*
  transition 可选值：
  "instant"       — 瞬间切换（默认）
  "dissolve"      — 淡入淡出
  "fade"          — 渐隐到目标帧
  "slide-left"    — 目标帧从右侧滑入
  "slide-right"   — 目标帧从左侧滑入
  "slide-up"      — 目标帧从底部滑入
  "slide-down"    — 目标帧从顶部滑入
  "push-left"     — 当前帧向左推出，目标帧从右进入
  "push-right"    — 当前帧向右推出，目标帧从左进入
  "push-up"       — 当前帧向上推出，目标帧从底部进入
  "push-down"     — 当前帧向下推出，目标帧从顶部进入
  "smart"         — Smart Animate（节点名称匹配差分动画）
*/
}

{
  /* ===== 缓动函数 ===== */
}
{
  /*
  easing 可选值："linear"（默认）| "ease-in" | "ease-out" | "ease-in-out" | "spring"
*/
}
;<Frame
  name="Btn"
  onClick={{ navigate: 'Next', transition: 'push-left', duration: 400, easing: 'spring' }}
/>

{
  /* ===== Overlay 位置 ===== */
}
{
  /*
  position 可选值：
  "center"         — 居中弹出（默认，适合模态框）
  "top"            — 顶部（下拉通知）
  "bottom"         — 底部（Action Sheet）
  "top-left"       — 左上角
  "top-right"      — 右上角
*/
}
;<Frame
  name="FAB"
  onClick={{ overlay: 'ActionSheet', position: 'bottom', closeOnBackdrop: true }}
/>

{
  /* ===== 多帧流程典型示例 ===== */
}
```

### 3.3 完整多帧原型示例（AI 生成参考）

```jsx
{/* 登录 → 首页 → 详情 三帧原型 */}

<Frame name="LoginScreen" w={390} h={844} bg="#F5F5F5" flex="col" items="center" justify="center" gap={24} p={32}>
  <Text size={28} weight="bold" color="#1A1A1A">欢迎回来</Text>
  <Frame name="EmailInput" w="fill" h={48} bg="white" rounded={12} stroke="#E0E0E0" />
  <Frame name="PasswordInput" w="fill" h={48} bg="white" rounded={12} stroke="#E0E0E0" />
  <Frame name="LoginBtn" w="fill" h={48} bg="#007AFF" rounded={12}
    onClick={{ navigate: "HomeScreen", transition: "slide-left", duration: 300, easing: "ease-out" }}>
    <Text color="white" weight="bold" size={16}>登录</Text>
  </Frame>
</Frame>

<Frame name="HomeScreen" w={390} h={844} bg="#F5F5F5" flex="col" x={410}>
  <Frame name="TopBar" w="fill" h={56} bg="white" flex="row" items="center" px={16}>
    <Text weight="bold" size={18} color="#1A1A1A">首页</Text>
  </Frame>
  <Frame name="Card1" w="fill" h={120} bg="white" rounded={16} mx={16} mt={16}
    onClick={{ navigate: "DetailScreen", transition: "push-left", duration: 350, easing: "ease-in-out" }}>
    <Text size={16} weight="bold" color="#1A1A1A">点击查看详情</Text>
  </Frame>
</Frame>

<Frame name="DetailScreen" w={390} h={844} bg="white" flex="col" x={820}>
  <Frame name="NavBar" w="fill" h={56} bg="white" flex="row" items="center" px={16} gap={12}>
    <Frame name="BackBtn" w={32} h={32} rounded={16}
      onClick={{ back: true }}>
      <Icon name="lucide:arrow-left" size={20} color="#007AFF" />
    </Frame>
    <Text weight="bold" size={18} color="#1A1A1A">详情页</Text>
  </Frame>
  <Frame name="ShareBtn" w={44} h={44} bg="#007AFF" rounded={22}
    onClick={{ overlay: "ShareSheet", position: "bottom", closeOnBackdrop: true }}>
    <Icon name="lucide:share" size={20} color="white" />
  </Frame>
</Frame>

{/* Overlay：分享面板 */}
<Frame name="ShareSheet" w={390} h={300} bg="white" rounded={20} flex="col" p={24} gap={16}>
  <Text weight="bold" size={18} color="#1A1A1A">分享到</Text>
  <Frame name="CloseShareBtn"
    onClick={{ close: true }}>
    <Icon name="lucide:x" size={20} color="#666" />
  </Frame>
</Frame>
```

---

## 四、核心实现细节

### 4.1 SceneNode 扩展（2 行改动）

```typescript
// packages/core/src/scene-graph/types.ts
export interface SceneNode {
  // ... 现有字段不变 ...
  reactions: Reaction[]  // 新增，默认 []
}

// packages/core/src/scene-graph/node-defaults.ts
export function createDefaultNode(...) {
  return {
    // ... 现有默认值 ...
    reactions: [],   // 新增
  }
}
```

### 4.2 Reaction 类型定义

```typescript
// packages/core/src/prototype/types.ts

export type TriggerType = 'ON_CLICK' | 'ON_HOVER' | 'ON_HOVER_END' | 'AFTER_DELAY'

export type TransitionType =
  | 'instant'
  | 'dissolve'
  | 'fade'
  | 'slide-left'
  | 'slide-right'
  | 'slide-up'
  | 'slide-down'
  | 'push-left'
  | 'push-right'
  | 'push-up'
  | 'push-down'
  | 'smart'

export type EasingType = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'spring'

export type OverlayPosition =
  | 'center'
  | 'top'
  | 'bottom'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'

export interface Transition {
  type: TransitionType
  duration: number // ms，默认 300
  easing: EasingType
  easingCurve?: [number, number, number, number] // custom cubic
  preserveScroll?: boolean
}

export type Action =
  | { type: 'NAVIGATE'; targetName: string; transition: Transition }
  | { type: 'BACK'; transition: Transition }
  | { type: 'CLOSE'; transition: Transition }
  | {
      type: 'OVERLAY'
      targetName: string
      position: OverlayPosition
      closeOnBackdrop: boolean
      transition: Transition
    }
  | { type: 'OPEN_URL'; url: string; newTab: boolean }

export interface Reaction {
  id: string
  trigger: TriggerType
  delay?: number // AFTER_DELAY 专用（ms）
  action: Action
}

// 演示模式的运行时状态
export interface PresentState {
  currentFrameId: string
  overlayStack: Array<{ frameId: string; position: OverlayPosition; closeOnBackdrop: boolean }>
  history: string[] // 导航历史栈（BACK 使用）
  transition: {
    fromId: string
    toId: string
    params: Transition
    progress: number // 0-1，rAF 驱动
    startTime: number
  } | null
}
```

### 4.3 JSX props 解析（核心改动）

在 `propsToOverrides.ts` 中新增一个解析函数，解析 onClick / onHover 等 props 为 `Reaction[]`：

```typescript
// packages/core/src/design-jsx/props-overrides.ts 中新增

const DEFAULT_TRANSITION: Transition = {
  type: 'instant',
  duration: 300,
  easing: 'ease-out'
}

function parseActionProp(raw: Record<string, unknown>): Action | null {
  // { navigate: "ScreenName", transition: "slide-left", duration: 300, easing: "ease-out" }
  if (typeof raw.navigate === 'string') {
    return {
      type: 'NAVIGATE',
      targetName: raw.navigate,
      transition: parseTransition(raw)
    }
  }
  // { back: true }
  if (raw.back === true) {
    return { type: 'BACK', transition: parseTransition(raw) }
  }
  // { close: true }
  if (raw.close === true) {
    return { type: 'CLOSE', transition: parseTransition(raw) }
  }
  // { overlay: "PanelName", position: "bottom", closeOnBackdrop: true }
  if (typeof raw.overlay === 'string') {
    return {
      type: 'OVERLAY',
      targetName: raw.overlay,
      position: (raw.position as OverlayPosition) ?? 'center',
      closeOnBackdrop: raw.closeOnBackdrop !== false,
      transition: parseTransition(raw)
    }
  }
  // { url: "https://...", newTab: true }
  if (typeof raw.url === 'string') {
    return {
      type: 'OPEN_URL',
      url: raw.url,
      newTab: raw.newTab !== false
    }
  }
  return null
}

function parseTransition(raw: Record<string, unknown>): Transition {
  return {
    type: (raw.transition as TransitionType) ?? 'instant',
    duration: typeof raw.duration === 'number' ? raw.duration : 300,
    easing: (raw.easing as EasingType) ?? 'ease-out'
  }
}

export function applyReactionOverrides(
  props: Record<string, unknown>,
  o: Partial<SceneNode>
): void {
  const reactions: Reaction[] = []

  const triggerMap: Array<[string, TriggerType]> = [
    ['onClick', 'ON_CLICK'],
    ['onHover', 'ON_HOVER'],
    ['onHoverEnd', 'ON_HOVER_END']
  ]

  for (const [propKey, triggerType] of triggerMap) {
    const raw = props[propKey]
    if (!raw || typeof raw !== 'object') continue
    const action = parseActionProp(raw as Record<string, unknown>)
    if (action) {
      reactions.push({
        id: crypto.randomUUID(),
        trigger: triggerType,
        action
      })
    }
  }

  // afterDelay={2000} do={{ navigate: "X" }}
  if (typeof props.afterDelay === 'number' && props.do) {
    const action = parseActionProp(props.do as Record<string, unknown>)
    if (action) {
      reactions.push({
        id: crypto.randomUUID(),
        trigger: 'AFTER_DELAY',
        delay: props.afterDelay,
        action
      })
    }
  }

  if (reactions.length > 0) o.reactions = reactions
}
```

在 `propsToOverrides` 主函数末尾调用：

```typescript
// packages/core/src/design-jsx/props-overrides.ts
export function propsToOverrides(props, isText, parentLayout): Partial<SceneNode> {
  const o: Partial<SceneNode> = {}
  const normalized = normalizeStyleProps(props)

  // ... 现有逻辑不变 ...
  applySizeOverrides(normalized, o, parentLayout)
  applyFillOverride(normalized, o)
  // ... 等等 ...

  // 新增：解析交互 props
  applyReactionOverrides(normalized, o)

  return o
}
```

### 4.4 targetName → targetId 延迟解析

AI 在 JSX 中用帧的 **name** 引用目标（`navigate: "HomeScreen"`），而不是 ID（ID 在渲染时才生成）。需要在所有帧渲染完成后做一次名称解析：

```typescript
// packages/core/src/design-jsx/renderer.ts

export async function renderTree(graph, tree, options): Promise<RenderResult> {
  // ... 现有渲染逻辑 ...
  const result = await renderNode(graph, tree, parentId)

  computeAllLayouts(graph)

  // 新增：解析所有节点中 reactions 的 targetName → 实际节点 ID
  resolveReactionTargets(graph, parentId)

  return { id: result.id, ... }
}

function resolveReactionTargets(graph: SceneGraph, pageId: string): void {
  // 构建当前页面的 name → id 映射
  const nameToId = new Map<string, string>()
  for (const node of graph.getAllNodes()) {
    if (node.name) nameToId.set(node.name, node.id)
  }

  // 遍历所有节点，将 targetName 解析为 targetId
  for (const node of graph.getAllNodes()) {
    if (!node.reactions?.length) continue
    const resolved = node.reactions.map(r => {
      const action = r.action
      if (
        (action.type === 'NAVIGATE' || action.type === 'OVERLAY') &&
        'targetName' in action
      ) {
        const targetId = nameToId.get(action.targetName)
        if (targetId) {
          return { ...r, action: { ...action, targetId, targetName: action.targetName } }
        }
      }
      return r
    })
    if (resolved !== node.reactions) {
      graph.updateNode(node.id, { reactions: resolved })
    }
  }
}
```

### 4.5 原型运行时引擎（纯函数，不可变）

```typescript
// packages/core/src/prototype/engine.ts

export function startPresent(graph: SceneGraph, startFrameId: string): PresentState {
  return {
    currentFrameId: startFrameId,
    overlayStack: [],
    history: [],
    transition: null
  }
}

export function handleClick(state: PresentState, nodeId: string, graph: SceneGraph): PresentState {
  return handleTrigger(state, nodeId, 'ON_CLICK', graph)
}

export function handleHover(
  state: PresentState,
  nodeId: string,
  entering: boolean,
  graph: SceneGraph
): PresentState {
  return handleTrigger(state, nodeId, entering ? 'ON_HOVER' : 'ON_HOVER_END', graph)
}

function handleTrigger(
  state: PresentState,
  nodeId: string,
  trigger: TriggerType,
  graph: SceneGraph
): PresentState {
  const node = graph.getNode(nodeId)
  if (!node?.reactions?.length) return state

  const reaction = node.reactions.find((r) => r.trigger === trigger)
  if (!reaction) return state

  return applyAction(state, reaction.action)
}

function applyAction(state: PresentState, action: Action): PresentState {
  switch (action.type) {
    case 'NAVIGATE': {
      const targetId = 'targetId' in action ? action.targetId : null
      if (!targetId) return state
      return {
        ...state,
        currentFrameId: targetId,
        overlayStack: [],
        history: [...state.history, state.currentFrameId],
        transition:
          action.transition.type !== 'instant'
            ? {
                fromId: state.currentFrameId,
                toId: targetId,
                params: action.transition,
                progress: 0,
                startTime: performance.now()
              }
            : null
      }
    }
    case 'BACK': {
      const prev = state.history.at(-1)
      if (!prev) return state
      return {
        ...state,
        currentFrameId: prev,
        history: state.history.slice(0, -1),
        overlayStack: [],
        transition: null
      }
    }
    case 'CLOSE':
      return {
        ...state,
        overlayStack: state.overlayStack.slice(0, -1)
      }
    case 'OVERLAY': {
      const targetId = 'targetId' in action ? action.targetId : null
      if (!targetId) return state
      return {
        ...state,
        overlayStack: [
          ...state.overlayStack,
          {
            frameId: targetId,
            position: action.position,
            closeOnBackdrop: action.closeOnBackdrop
          }
        ]
      }
    }
    case 'OPEN_URL':
      window.open(action.url, action.newTab ? '_blank' : '_self')
      return state
    default:
      return state
  }
}

// 命中测试：找到被点击节点中最顶层有 reactions 的那个
export function hitTestReactions(
  graph: SceneGraph,
  frameId: string,
  canvasX: number,
  canvasY: number,
  trigger: TriggerType
): string | null {
  const frame = graph.getNode(frameId)
  if (!frame) return null
  return hitTestNode(graph, frame, canvasX, canvasY, 0, 0, trigger)
}

function hitTestNode(
  graph: SceneGraph,
  node: SceneNode,
  x: number,
  y: number,
  ox: number,
  oy: number,
  trigger: TriggerType
): string | null {
  if (!node.visible) return null
  const ax = ox + node.x
  const ay = oy + node.y

  // 子节点优先（z-order 从上到下）
  for (let i = node.childIds.length - 1; i >= 0; i--) {
    const child = graph.getNode(node.childIds[i])
    if (!child) continue
    const hit = hitTestNode(graph, child, x, y, ax, ay, trigger)
    if (hit) return hit
  }

  // 节点自身
  const inBounds = x >= ax && x <= ax + node.width && y >= ay && y <= ay + node.height
  if (inBounds && node.reactions?.some((r) => r.trigger === trigger)) {
    return node.id
  }
  return null
}
```

### 4.6 演示视图（`src/views/PresentView.vue`）

```vue
<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useEditorStore } from '@/app/editor/active-store'
import {
  startPresent,
  handleClick,
  handleHover,
  hitTestReactions
} from '@open-pencil/core/prototype'
import { applyEasing } from '@open-pencil/core/prototype/transitions'

const router = useRouter()
const store = useEditorStore()

// 取当前页面第一个顶级 Frame 作为起始帧
const startFrameId = computed(() => {
  const page = store.graph.getNode(store.state.currentPageId)
  return (
    page?.childIds.find((id) => {
      const n = store.graph.getNode(id)
      return n?.type === 'FRAME'
    }) ?? ''
  )
})

const presentState = ref(startPresent(store.graph, startFrameId.value))

// 所有顶级帧（以帧 name 为 key 的 Map，用于 Flow 切换）
const allFrames = computed(() => {
  const page = store.graph.getNode(store.state.currentPageId)
  if (!page) return []
  return page.childIds.map((id) => store.graph.getNode(id)).filter((n) => n?.type === 'FRAME')
})

// 当前帧尺寸（用于 overlay 定位）
const currentFrame = computed(() => store.graph.getNode(presentState.value.currentFrameId))

// rAF 过渡动画
let rafId = 0
function tickTransition() {
  const t = presentState.value.transition
  if (!t) return
  const elapsed = performance.now() - t.startTime
  const raw = Math.min(elapsed / t.params.duration, 1)
  const progress = applyEasing(raw, t.params.easing)
  if (raw >= 1) {
    presentState.value = { ...presentState.value, transition: null }
    return
  }
  presentState.value = {
    ...presentState.value,
    transition: { ...t, progress }
  }
  rafId = requestAnimationFrame(tickTransition)
}

watch(
  () => presentState.value.transition?.startTime,
  () => {
    cancelAnimationFrame(rafId)
    if (presentState.value.transition) rafId = requestAnimationFrame(tickTransition)
  }
)

// 定时触发（AFTER_DELAY）
const delayTimers: ReturnType<typeof setTimeout>[] = []
watch(
  () => presentState.value.currentFrameId,
  (frameId) => {
    delayTimers.forEach(clearTimeout)
    delayTimers.length = 0
    const frame = store.graph.getNode(frameId)
    if (!frame) return
    // 遍历帧内所有节点，找 AFTER_DELAY reactions
    collectDelayReactions(store.graph, frame).forEach(({ nodeId, delay, reaction }) => {
      const timer = setTimeout(() => {
        presentState.value = applyAction(presentState.value, reaction.action)
      }, delay)
      delayTimers.push(timer)
    })
  },
  { immediate: true }
)

// 鼠标事件处理
const canvasRef = ref<HTMLCanvasElement | null>(null)

function getCanvasCoords(e: MouseEvent): { x: number; y: number } {
  const rect = canvasRef.value?.getBoundingClientRect()
  if (!rect) return { x: 0, y: 0 }
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function onCanvasClick(e: MouseEvent) {
  const { x, y } = getCanvasCoords(e)
  // 先检查 overlay 层
  const overlayTop = presentState.value.overlayStack.at(-1)
  if (overlayTop) {
    const nodeId = hitTestReactions(store.graph, overlayTop.frameId, x, y, 'ON_CLICK')
    if (nodeId) {
      presentState.value = handleClick(presentState.value, nodeId, store.graph)
      return
    }
    // 点击遮罩区域关闭 overlay
    if (overlayTop.closeOnBackdrop) {
      presentState.value = {
        ...presentState.value,
        overlayStack: presentState.value.overlayStack.slice(0, -1)
      }
    }
    return
  }
  // 主帧命中测试
  const nodeId = hitTestReactions(store.graph, presentState.value.currentFrameId, x, y, 'ON_CLICK')
  if (nodeId) presentState.value = handleClick(presentState.value, nodeId, store.graph)
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (presentState.value.overlayStack.length > 0) {
      presentState.value = {
        ...presentState.value,
        overlayStack: presentState.value.overlayStack.slice(0, -1)
      }
    } else {
      router.push('/')
    }
  }
  if (e.key === 'Backspace' || e.key === 'ArrowLeft') {
    const prev = presentState.value.history.at(-1)
    if (prev) {
      presentState.value = {
        ...presentState.value,
        currentFrameId: prev,
        history: presentState.value.history.slice(0, -1),
        overlayStack: [],
        transition: null
      }
    }
  }
}

onMounted(() => window.addEventListener('keydown', onKeyDown))
onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
  cancelAnimationFrame(rafId)
  delayTimers.forEach(clearTimeout)
})
</script>

<template>
  <div class="fixed inset-0 bg-[#2C2C2C] flex items-center justify-center">
    <!-- 主帧区域 -->
    <div
      class="relative overflow-hidden"
      :style="{
        width: `${currentFrame?.width ?? 390}px`,
        height: `${currentFrame?.height ?? 844}px`
      }"
    >
      <!-- 过渡：from 帧（离开） -->
      <PrototypeFrameCanvas
        v-if="presentState.transition"
        :frame-id="presentState.transition.fromId"
        :graph="store.graph"
        :renderer="store.renderer"
        :style="getFrameStyle('from', presentState.transition)"
        class="absolute inset-0"
      />

      <!-- 主帧（当前） -->
      <PrototypeFrameCanvas
        ref="canvasRef"
        :frame-id="presentState.currentFrameId"
        :graph="store.graph"
        :renderer="store.renderer"
        :style="presentState.transition ? getFrameStyle('to', presentState.transition) : {}"
        class="absolute inset-0"
        @click="onCanvasClick"
      />

      <!-- Overlay 层 -->
      <template v-for="(overlay, i) in presentState.overlayStack" :key="overlay.frameId + i">
        <!-- 遮罩 -->
        <div
          class="absolute inset-0 bg-black/40"
          @click="overlay.closeOnBackdrop && closeTopOverlay()"
        />
        <!-- Overlay 帧 -->
        <PrototypeOverlayCanvas
          :frame-id="overlay.frameId"
          :position="overlay.position"
          :graph="store.graph"
          :renderer="store.renderer"
          @click="handleOverlayClick(overlay.frameId, $event)"
        />
      </template>
    </div>

    <!-- 工具栏 -->
    <div class="fixed top-4 right-4 flex items-center gap-2">
      <!-- 流程切换 -->
      <select
        class="bg-white/10 text-white text-sm rounded px-2 py-1"
        @change="(e) => switchToFrame((e.target as HTMLSelectElement).value)"
      >
        <option v-for="frame in allFrames" :key="frame?.id" :value="frame?.id">
          {{ frame?.name }}
        </option>
      </select>
      <!-- 返回编辑 -->
      <button
        class="bg-white/10 hover:bg-white/20 text-white text-sm rounded px-3 py-1.5"
        @click="router.push('/')"
      >
        ← 返回编辑
      </button>
    </div>
  </div>
</template>
```

### 4.7 路由注册（4 行）

```typescript
// src/router.ts
import PresentView from './views/PresentView.vue'

const router = createRouter({
  routes: [
    { path: '/', component: EditorView },
    { path: '/demo', component: EditorView, meta: { demo: true } },
    { path: '/share/:roomId', component: EditorView },
    { path: '/present', component: PresentView } // 新增
  ]
})
```

### 4.8 过渡动画（`packages/core/src/prototype/transitions.ts`）

```typescript
export function applyEasing(t: number, easing: EasingType): number {
  switch (easing) {
    case 'linear':
      return t
    case 'ease-in':
      return t * t * t
    case 'ease-out':
      return 1 - Math.pow(1 - t, 3)
    case 'ease-in-out':
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    case 'spring':
      return 1 - Math.exp(-6 * t) * Math.cos(20 * t)
    default:
      return t
  }
}

// 计算帧在过渡中的 CSS transform / opacity
export function getFrameTransitionStyle(
  phase: 'from' | 'to',
  transition: TransitionType,
  progress: number,
  frameW: number,
  frameH: number
): Record<string, string> {
  const p = progress

  const slideMap: Partial<Record<TransitionType, [string, string]>> = {
    'slide-left': ['translateX(100%)', 'translateX(0)'],
    'slide-right': ['translateX(-100%)', 'translateX(0)'],
    'slide-up': ['translateY(100%)', 'translateY(0)'],
    'slide-down': ['translateY(-100%)', 'translateY(0)'],
    'push-left': ['translateX(100%)', 'translateX(0)'],
    'push-right': ['translateX(-100%)', 'translateX(0)'],
    'push-up': ['translateY(100%)', 'translateY(0)'],
    'push-down': ['translateY(-100%)', 'translateY(0)']
  }

  if (transition === 'dissolve' || transition === 'fade') {
    return { opacity: phase === 'to' ? String(p) : String(1 - p) }
  }

  const slide = slideMap[transition]
  if (slide) {
    if (phase === 'to') {
      // 从边缘移到中心（interpolate between start and 0）
      const isX = transition.includes('left') || transition.includes('right')
      const dist = isX ? frameW : frameH
      const dir = transition.includes('left') || transition.includes('up') ? 1 : -1
      const offset = dist * dir * (1 - p)
      return { transform: `translate${isX ? 'X' : 'Y'}(${offset}px)` }
    } else {
      // push：from 帧向反方向移出
      if (transition.startsWith('push')) {
        const isX = transition.includes('left') || transition.includes('right')
        const dist = isX ? frameW : frameH
        const dir = transition.includes('left') || transition.includes('up') ? -1 : 1
        const offset = dist * dir * p
        return { transform: `translate${isX ? 'X' : 'Y'}(${offset}px)` }
      }
      // slide：from 帧保持不动
      return {}
    }
  }

  return {}
}
```

---

## 五、AI System Prompt 更新

在 `src/app/ai/chat/system-prompt.md` 的 Props reference 章节新增一节：

```markdown
## Prototype Interactions

Add interactivity to frames with these props. **Use frame `name` to reference targets — not IDs.**

**onClick** — triggered on tap/click:
`onClick={{ navigate: "TargetFrame" }}`
`onClick={{ navigate: "TargetFrame", transition: "slide-left", duration: 300, easing: "ease-out" }}`
`onClick={{ back: true }}` — go to previous frame
`onClick={{ close: true }}` — close current overlay
`onClick={{ overlay: "PanelName", position: "bottom", closeOnBackdrop: true }}`
`onClick={{ url: "https://...", newTab: true }}`

**onHover** / **onHoverEnd** — hover enter/leave.

**afterDelay + do** — auto-advance after N ms (for splash screens, carousels):
`afterDelay={2000} do={{ navigate: "HomeScreen", transition: "fade", duration: 400 }}`

**transition** values: "instant" | "dissolve" | "fade" | "slide-left" | "slide-right" | "slide-up" | "slide-down" | "push-left" | "push-right" | "push-up" | "push-down" | "smart"

**easing** values: "linear" | "ease-in" | "ease-out" (default) | "ease-in-out" | "spring"

**position** (overlay): "center" | "top" | "bottom" | "top-left" | "top-right"

⚠ All frames in a flow should be rendered in the **same page**, placed side by side (x={0}, x={410}, x={820}...). The presenter will only show one at a time.

⚠ Overlay frames should also be placed in the page — they're shown floating over the current frame.

⚠ Interactive elements (buttons, cards) need a concrete size — don't use w="hug" on clickable areas.
```

---

## 六、AI 典型工作流

实现后，用户与 AI 的对话示例：

```
用户：帮我做一个3页的 App 原型：登录页、首页、详情页，
      登录按钮点击跳转首页，首页卡片点击进入详情，详情有返回按钮

AI：（调用 render 工具，一次生成3帧 + 交互）
  render({
    jsx: `
      <Frame name="LoginScreen" ...>
        <Frame name="LoginBtn" onClick={{ navigate: "HomeScreen", transition: "slide-left" }}>
          <Text>登录</Text>
        </Frame>
      </Frame>
      <Frame name="HomeScreen" x={410} ...>
        <Frame name="Card" onClick={{ navigate: "DetailScreen", transition: "push-left" }}>
          ...
        </Frame>
      </Frame>
      <Frame name="DetailScreen" x={820} ...>
        <Frame name="BackBtn" onClick={{ back: true }}>
          <Icon name="lucide:arrow-left" />
        </Frame>
      </Frame>
    `
  })

AI 文本：已生成3帧原型稿。点击右上角「演示」按钮即可查看交互效果。
         LoginScreen 390×844，主色 #007AFF。
```

用户点击工具栏的「▶ 演示」按钮 → 跳转 `/present` → 可点击交互。

---

## 七、工作量评估

| 模块                                        | 工作量      | 说明             |
| ------------------------------------------- | ----------- | ---------------- |
| `prototype/types.ts`                        | 0.5 天      | 纯类型定义       |
| `prototype/engine.ts` 状态机                | 1 天        | 纯函数，无副作用 |
| `prototype/transitions.ts` 过渡计算         | 0.5 天      | CSS 参数映射     |
| `design-jsx/props-overrides.ts` 扩展        | 0.5 天      | 新增解析分支     |
| `scene-graph/types.ts` + `node-defaults.ts` | 0.25 天     | 2 行改动         |
| `PresentView.vue` + `PrototypeFrame*`       | 2 天        | 主体 UI 工作量   |
| 路由注册                                    | 0.25 天     | 4 行             |
| System prompt 更新                          | 0.5 天      | 文案撰写 + 调试  |
| 过渡动画调试（CSS/rAF）                     | 1 天        | 视觉体验打磨     |
| 单元测试（engine.ts）                       | 0.5 天      | 纯函数易测       |
| **合计**                                    | **~7 人天** |                  |

与通用原型系统（~18 人天）相比，聚焦 AI 场景后工作量减少约 60%，原因：

- 不需要 Kiwi 解析层（不兼容 Figma 导入原型数据）
- 不需要编辑器内的连接线编辑 UI
- 不需要原型属性面板
- 复用现有 SkiaRenderer 渲染帧内容

---

## 八、后续可扩展方向

| 功能              | 前置依赖              | 额外工作量 |
| ----------------- | --------------------- | ---------- |
| Figma 导入原型    | Kiwi 解析扩展         | +5 天      |
| 画布连接线显示    | SkiaRenderer overlays | +2 天      |
| 右侧原型属性面板  | 编辑 UI 系统          | +3 天      |
| Smart Animate     | 节点差分 + 插值       | +3 天      |
| 手势触发（Swipe） | 触摸事件识别          | +1 天      |
| 原型分享链接      | URL 参数 + 文档加载   | +2 天      |
| 变量与条件        | 变量系统扩展          | +5 天      |
