# Shelfmark · 书签 AI 分类整理插件 · 实现计划

> 已锁定：WXT + TypeScript + Vue 3；写回 Chrome 原生文件夹；用户自填 Key（OpenAI-compatible）；只发标题 + 脱敏后的 URL + 已有文件夹路径；先预览再写入，带 snapshot / undo / 自动 HTML 备份；无后端、无 content script、无 `<all_urls>`（跨域用 `optional_host_permissions` 按 origin 申请）。
>
> 定位：自用 / 小范围分享，开发者模式加载。不为上架做打磨。

---

## 0. 产品范围

### V1 要做

1. 读取并展示完整书签树
2. Options 里配置 Provider（baseUrl / apiKey / model），按 origin 申请 host 权限并测通
3. 两阶段 AI：生成类目（支持用户预填 seedCategories、一句话 userHint）→ 批量归类 → 未分类过多时二轮补类目
4. 预览将要新建的文件夹、将要移动的书签、重复 URL
5. 应用前自动下载 HTML 备份；应用写入 Chrome 书签 + 一键撤销最近一次整理；中断后重开可一键回滚
6. 点击扩展图标打开 side panel

### V1 明确不做

- 账号 / 自建后端
- 抓网页正文
- 失效链接扫描
- 静默自动移动（必须预览确认）
- 语义向量搜索
- Firefox 优先适配（WXT 能出包，但先保证 Chrome / Edge）
- 改「书签栏 / 其他书签 / 移动书签」这些根节点本身
- 勾选任意文件夹 / 书签作为整理范围（`scope: 'selected'`，放 V1.1）
- 应用被中断后「继续执行」（V1 只做回滚）
- 上架相关：商店文案、多语言 UI、权限警告优化

### 默认整理策略

- 优先复用用户已有的自定义文件夹
- 默认只整理「其他书签」里的散装书签，以及书签栏上未进文件夹的书签
- 已有命名文件夹默认不拆
- 新建文件夹最多 2 层；maxDepth=2 时书签只分到叶子类目，父类目纯结构
- 类目数量建议 8–12 个
- 新文件夹各归各根：书签栏的散装书签进书签栏内的文件夹，「其他书签」的进「其他书签」，不跨根移动；复用已有文件夹也只对同一根下的书签生效，另一根按同名新建
- 语言 `auto` 按书签标题中 CJK 字符比例判定（> 30% → zh，否则 en）
- 企业策略书签（`unmodifiable: 'managed'`）不进整理范围；账号 / 本地双树按 `folderType + syncing` 区分，不跨树移动

---

## 1. 初始化

项目就放在当前 `shelfmark/` 目录，不再套一层子目录。`wxt init` 遇到非空目录会直接 abort（只容忍 `.git`），所以先初始化到临时目录再拷回：

```bash
cd /home/pax/Project/front_project/shelfmark
pnpm dlx wxt@latest init .tmp-init --template vue --pm pnpm
cp -a .tmp-init/. . && rm -rf .tmp-init
pnpm install
pnpm add zod tldts
pnpm add -D tailwindcss @tailwindcss/vite vitest
```

图标点击打开 side panel，不依赖 popup。popup 目录可以删掉，或留一个跳转按钮。

`wxt.config.ts`：

```ts
import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  srcDir: 'src',
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: 'Shelfmark',
    description: '用 AI 预览并整理 Chrome 书签文件夹',
    minimum_chrome_version: '134',
    permissions: ['bookmarks', 'storage', 'unlimitedStorage', 'sidePanel'],
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    action: {},
  },
});
```

manifest 要点：

- **不要 `tabs`**。`tabs.create` 不需要该权限（只有读 `url` / `title` 才需要），加了反而触发「读取浏览记录」的安装警告。
- **`minimum_chrome_version: '134'`**。`folderType` / `syncing` 都是 Chrome 134+，低版本根节点识别会整体失效，宁可拒绝安装。
- **`optional_host_permissions`**。安装时不申请任何 host；options 页测试连接时只申请用户填的那一个 origin（见第 4 节）。`http://localhost/*` 按 Chrome 文档匹配任意端口，Ollama（11434）、LM Studio（1234）都覆盖。局域网 http 端点不在列表内，需要的话自己加 `http://*/*`。

`entrypoints/background.ts` 里加上：

```ts
export default defineBackground(() => {
  browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
```

打开全屏整理页：`browser.tabs.create({ url: browser.runtime.getURL('/organize.html') })`，无需任何权限。

---

## 2. 目录

```
src/
  assets/styles.css
  entrypoints/
    background.ts
    sidepanel/
      index.html
      main.ts
      App.vue
    options/
      index.html
      main.ts
      App.vue
    organize/
      index.html          # 未列出页面，批量整理长任务跑这里
      main.ts
      App.vue
  lib/
    types.ts
    settings.ts
    bookmarks/
      api.ts              # BookmarksApi 接口 + 真实实现（包一层 browser.bookmarks）
      fake.ts             # 内存实现，测试注入用，index 语义与 Chrome 一致
      tree.ts             # 读树、展平、识别根节点、排除 managed
      mutate.ts           # ensureFolder / moveBookmark / removeEmptyCreatedFolders
      snapshot.ts         # 解析移动、拍快照、应用（带 journal）、撤销 / 回滚
      backup.ts           # 生成 Netscape HTML 备份并触发下载
    ai/
      client.ts           # OpenAI-compatible fetch
      schema.ts           # zod
      prompts.ts
      privacy.ts          # URL 脱敏、标题打码
      sampling.ts         # 域名直方图、重复 URL 检测
      taxonomy.ts         # propose + refine
      assign.ts           # batch assign（并发 2–3）
    jobs/
      organizer.ts        # 状态机：idle → propose → assign → (refine) → review → apply → done
      store.ts            # storage.local 持久化 job / snapshot
  composables/
    useBookmarkTree.ts
    useSettings.ts
    useOrganizeJob.ts
  components/
    BookmarkTree.vue
    ProviderForm.vue
    DomainHistogram.vue
    SeedCategoriesInput.vue
    ProposalPreview.vue
    JobProgress.vue
    UndoBar.vue
tests/
  snapshot.property.test.ts   # 随机树 → apply → undo → 等于原树
  tree.test.ts
  privacy.test.ts
```

WXT 约定：

- `entrypoints/sidepanel/index.html` → `/sidepanel.html`
- `entrypoints/options/index.html` → options 页
- `entrypoints/organize/index.html` → `/organize.html`（unlisted，不进 manifest）

相关文件必须放进对应目录，不要把 `organize.ts` 直接丢在 `entrypoints/` 根下。

没有 `messaging.ts`：书签读写和 AI 请求都在 organize 页自己做（见第 7 节），background 不参与。

---

## 3. 核心类型

```ts
// src/lib/types.ts

export type ProviderConfig = {
  baseUrl: string;   // 例 https://api.openai.com/v1
  apiKey: string;
  model: string;     // 例 gpt-4o-mini / deepseek-chat
};

export type Settings = {
  provider: ProviderConfig;
  scope: 'loose-other' | 'loose-bar-and-other';   // 'selected' 放 V1.1
  maxDepth: 1 | 2;
  batchSize: number;          // 默认 30
  concurrency: 1 | 2 | 3;     // assign 批次并发，默认 2
  language: 'zh' | 'en' | 'auto';
  domainOnly: boolean;        // 仅域名模式：url 字段只发 hostname
  autoBackup: boolean;        // 应用前自动下载 HTML 备份，默认 true
  seedCategories: string[];   // 用户预填的顶层类目，可空
  userHint: string;           // 一句话偏好，可空
  debugLimit?: number;        // 只处理前 N 条，打通流程用
};

export type FlatBookmark = {
  id: string;
  title: string;
  url: string;
  parentId: string;
  index: number;
  rootId: string;             // 所属根节点 id（bookmarks-bar / other），各归各根用
  folderPath: string[];       // 从根到父文件夹的标题路径
  syncing?: boolean;
};

export type FolderNode = {
  id: string;
  title: string;
  folderType?: 'bookmarks-bar' | 'other' | 'mobile' | 'managed';
  unmodifiable?: 'managed';
  syncing?: boolean;
  children: Array<FolderNode | FlatBookmark>;
};

export type Category = {
  id: string;                 // 本地生成：c1, c2…；模型输出的 id 只在 propose 阶段内部引用，落地前重编号
  title: string;              // 显示名，如 前端
  parentId?: string;          // 可选二级类，指向另一个 c*
  existingFolderId?: string;  // 若复用已有文件夹：真实 Chrome id，由 f* 映射得到
};

export type Assignment = {
  bookmarkId: string;
  categoryId: string;         // c* 或 'uncategorized'
  confidence: 'high' | 'medium' | 'low';
};

export type Proposal = {
  categories: Category[];
  assignments: Assignment[];
  duplicates: Array<{ url: string; bookmarkIds: string[] }>;   // 本地检测，只展示
  warnings: { unknownCategory: number; missingIndex: number }; // 模型输出被兜底的条数
};

// assignments 解析成目标文件夹后的结果（目标文件夹已 ensureFolder，id 真实）
export type ResolvedMove = {
  bookmarkId: string;
  toParentId: string;
};

export type SnapshotItem = ResolvedMove & {
  fromParentId: string;
  fromIndex: number;          // 第一条 move 之前读取
  title: string;
  url: string;
};

export type Snapshot = {
  id: string;
  createdAt: number;
  items: SnapshotItem[];      // 计划移动的全部条目
  createdFolderIds: string[];
  applied: string[];          // journal：已成功 move 的 bookmarkId，按执行顺序追加
  status: 'applying' | 'applied' | 'rolled-back' | 'undone';
};

export type JobPhase =
  | 'idle'
  | 'loading-tree'
  | 'proposing'
  | 'assigning'
  | 'refining'
  | 'review'
  | 'applying'
  | 'done'
  | 'error';

export type OrganizeJob = {
  id: string;
  phase: JobPhase;
  total: number;
  done: number;
  proposal?: Proposal;
  snapshotId?: string;
  skipped: Array<{ bookmarkId: string; reason: string }>;   // apply 前校验被剔除的
  error?: string;
};
```

---

## 4. 设置与存储

`src/lib/settings.ts` 用 WXT storage：

```ts
export const settingsStorage = storage.defineItem<Settings>('local:settings', {
  fallback: {
    provider: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
    },
    scope: 'loose-other',
    maxDepth: 2,
    batchSize: 30,
    concurrency: 2,
    language: 'auto',
    domainOnly: false,
    autoBackup: true,
    seedCategories: [],
    userHint: '',
  },
});
```

规则：

- API Key **只进 `storage.local`**，绝不 `sync`
- 书签树不另存一份完整副本
- job、proposal、snapshot 也进 `storage.local`（`src/lib/jobs/store.ts`），key：`local:job`、`local:snapshot`。数据量几百 KB，配合已声明的 `unlimitedStorage` 不用担心配额；V1 只保留 1 个 job 和 1 份 snapshot
- **不用 IndexedDB**，少一套持久化代码

测通连接（options 页「测试连接」按钮，必须在点击事件里调用，`permissions.request` 要求用户手势）：

```ts
const origin = new URL(provider.baseUrl).origin;
const granted = await browser.permissions.request({ origins: [`${origin}/*`] });
if (!granted) toast('未授权该地址，将依赖服务商的 CORS；本地模型 / 中转站可能失败');
```

然后：

```http
POST {baseUrl}/chat/completions
Authorization: Bearer {apiKey}
{ model, messages: [{ role: "user", content: "ping" }], max_tokens: 4 }
```

- 用 `permissions.contains` 在表单上显示当前 origin 是否已授权
- 换 baseUrl 时可 `permissions.remove` 旧 origin（可选）
- 推理类模型可能拒绝 `max_tokens` / `temperature`，400 里提到这些字段时去掉重试一次

---

## 5. 书签层

### 5.0 接口 `lib/bookmarks/api.ts`

所有书签读写都通过一个薄接口，方便测试注入内存实现：

```ts
export interface BookmarksApi {
  getTree(): Promise<BookmarkTreeNode[]>;
  create(details: { parentId: string; title: string; url?: string; index?: number }): Promise<BookmarkTreeNode>;
  move(id: string, dest: { parentId: string; index?: number }): Promise<BookmarkTreeNode>;
  remove(id: string): Promise<void>;
}
```

真实实现直接包 `browser.bookmarks.*`。`fake.ts` 的内存实现必须复刻 Chrome 的 index 语义：

- `create` / `move` 省略 `index` → 追加到末尾；`index > children.length` → 抛错
- `move` 到同一个 parent → 直接抛错（我们不做同 parent 移动，Chrome 在这里的 index 语义是「移动前的位置」，有坑；fake 抛错能在测试里抓住误用）
- `remove` 非空文件夹或根节点 → 抛错（与 `bookmarks.remove` 一致）
- `getTree` 返回深拷贝，`index` 字段按当前位置重算

`tree.ts` / `mutate.ts` / `snapshot.ts` 只依赖 `BookmarksApi`，不直接 import `browser`。

### 5.1 读树 `lib/bookmarks/tree.ts`

- `api.getTree()`
- 用 `folderType` / `syncing` 认根节点，禁止用「书签栏」这种本地化名字，也禁止写死 id
- 跳过 `folderType === 'managed'` / `unmodifiable === 'managed'` 的整个子树
- 展平出 `FlatBookmark[]`，带 `rootId`
- `isLoose(node)`：父节点是 bookmarks-bar 或 other，且自己是书签不是文件夹
- `listReusableFolders(rootId)`：该根下用户自己建的命名文件夹，供 AI 复用；排除 managed
- Chrome 双树：同一 `folderType` 可能有 `syncing: true / false` 两份，按 `rootId` 分别处理，不跨树移动

整理范围按 settings.scope 过滤，默认 `loose-other`；`debugLimit` 有值时只取前 N 条。

### 5.2 写入 `lib/bookmarks/mutate.ts`

只封装三个动作：

- `ensureFolder(parentId, title)`：同级同名则复用，否则 `create({ parentId, title })` **不传 index，追加到末尾**，不改动现有兄弟的 index。同名判断先 normalize：`trim` + NFKC + 忽略大小写，否则每次整理都会叠一层「前端 (1)」
- `moveBookmark(id, { parentId, index? })`
- `removeEmptyCreatedFolders(ids)`：撤销 / 回滚时用，**只用 `remove()`**，非空会抛错，catch 后保留该文件夹。绝不 `removeTree`，避免误删用户在新文件夹里手动加的东西

每次写入都 catch，失败写入 job.error，不要半静默。

不做同 parent 内的 move：`toParentId === fromParentId` 的条目在解析阶段直接剔除。

### 5.3 Snapshot `lib/bookmarks/snapshot.ts`

应用算法（`applySnapshot`）：

0. `autoBackup` 开着就先生成并下载 HTML 备份（见 5.4）
1. 重新 `getTree()`，校验每条待移动书签仍存在且 `parentId` 未变；变了的进 `job.skipped` 并在结果页提示
2. 解析 `assignments → ResolvedMove`：按书签的 `rootId` 找该根下的目标文件夹路径（父类目 / 叶子类目标题）；`existingFolderId` 只对同一根下的书签生效，另一根按同名新建；`uncategorized` 和未勾选的条目不动；`toParentId === fromParentId` 的剔除
3. 按目标文件夹 `ensureFolder`（追加末尾），记下 `createdFolderIds`
4. 读取每条书签当前的 `parentId + index` 组成 `SnapshotItem`（此时文件夹已建好，但还没 move 任何东西，index 是移动前的真实值）
5. **snapshot 以 `status: 'applying'` 落盘，然后才开始 move**
6. 串行 move（不传 index，追加到目标文件夹末尾）；每成功一条把 `bookmarkId` 追加进 `snapshot.applied` 并落盘
7. 全部成功 → `status: 'applied'`，可撤销
8. 中途失败 → 对 `applied` 子集执行回滚（见下），`status: 'rolled-back'`，错误进 `job.error`

移出顺序无关紧要：`fromIndex` 已在第 4 步全部读好，后续 move 只会让源文件夹里更靠后的兄弟 index 减一，但我们不再读它。

撤销 / 回滚算法（`restoreSnapshot`，同一个函数，输入 = `items` 中 `bookmarkId ∈ applied` 的子集）：

1. 按 `fromParentId` 分组，组内按 `fromIndex` **升序**
2. 逐条 `move(id, { parentId: fromParentId, index: Math.min(fromIndex, children.length) })`
3. 书签已被用户删除 → 跳过并计数；源文件夹已不存在 → 移到对应根节点末尾并计数
4. 删除 `createdFolderIds` 中已空的文件夹（`remove()`，非空保留）
5. `status` → `'undone'`（用户撤销）或 `'rolled-back'`（失败 / 中断回滚）；结果页显示「恢复 N/M」

**为什么必须升序**：其他书签 = `[b0, b1, b2, b3]`，新建 F 追加到末尾，全部移入后为 `[F]`。升序 b0→0、b1→1、b2→2、b3→3 得到 `[b0, b1, b2, b3, F]`，与原状一致。降序第一步 b3→index 3 时 `children.length` 是 1，Chrome 直接抛 index 越界。

中断保护：

- `applying` 阶段挂 `beforeunload`，关页会弹「离开此页面？」
- organize 页启动时读 `local:snapshot`；若 `status === 'applying'` → 顶部横幅「上次整理被中断，已移动 N/M」+「回滚」按钮，回滚就是对 `applied` 子集调 `restoreSnapshot`
- sidepanel 的 `UndoBar` 也检查这个状态，同样提供回滚
- V1 不做「继续执行」

### 5.4 备份 `lib/bookmarks/backup.ts`

- 输入 `getTree()` 结果，输出 Netscape Bookmark File 格式 HTML：`<!DOCTYPE NETSCAPE-Bookmark-file-1>` + 嵌套 `<DL><p>` / `<DT><H3>` / `<DT><A HREF ADD_DATE>`，标题和 URL 做 HTML 转义
- `URL.createObjectURL(new Blob([html], { type: 'text/html' }))` + `<a download="shelfmark-backup-YYYYMMDD-HHmm.html">` 触发点击。扩展页里这样下载**不需要 `downloads` 权限**
- 应用前自动执行；Chrome 书签管理器可以直接「导入」这份文件，是撤销之外的第二道保险

---

## 6. AI 层

### 6.1 Client `lib/ai/client.ts`

不要装官方 SDK。一个 `chatJson<T>()`：

```ts
export async function chatJson<T>(args: {
  provider: ProviderConfig;
  system: string;
  user: string;
  schema: ZodType<T>;
}): Promise<T>
```

实现要点：

- `POST ${baseUrl.replace(/\/$/, '')}/chat/completions`
- header：`Authorization: Bearer ${apiKey}`
- body：`{ model, temperature: 0.2, messages, response_format: { type: 'json_object' } }`
- 解析前先剥掉 ``` / ```json 围栏，再 `JSON.parse`，再 zod
- zod 校验失败重试 1 次，并在 user 里附上校验错误
- 429 / 5xx：指数退避，最多 3 次
- 超时 60s（`AbortController`）
- 服务商不支持 `response_format`（400 里提到它）→ 去掉该字段重试一次；拒绝 `temperature` 同理
- `TypeError: Failed to fetch` → 提示「可能是 CORS 或未授权该 origin，去设置页重新测试连接」
- **请求和日志里打码 apiKey**

### 6.2 发送前预处理 `lib/ai/privacy.ts` / `lib/ai/sampling.ts`

- `sanitizeUrl(url, domainOnly)`：去掉 query 和 fragment；路径最多保留前 3 段、总长 ≤ 120；`domainOnly` 时只保留 hostname
- `redactTitle(title)`：邮箱替换为 `[email]`；长度 ≤ 120
- `domainHistogram(bookmarks)`：用 `tldts` 取 eTLD+1 聚合，输出 `{ domain, count, sampleTitles }[]`（每域最多 2 个标题），按 count 降序取前 150
- `findDuplicates(bookmarks)`：按去 fragment、去尾部 `/` 的完整 URL 分组，出现 ≥ 2 次的进 `proposal.duplicates`；V1 只展示不删
- `detectLanguage(titles)`：CJK 字符比例 > 30% → zh，否则 en；`language: 'auto'` 时用

### 6.3 Propose

```ts
export const taxonomySchema = z.object({
  categories: z.array(z.object({
    id: z.string().min(1).max(40),                        // 模型自拟，只用于本次输出内 parentId 引用
    title: z.string().min(1).max(20),
    parentId: z.string().optional(),
    existingFolderRef: z.string().regex(/^f\d+$/).optional(),
  })).min(4).max(16),
});
```

User payload（域名直方图代替抽样，覆盖全量且 token 更少）：

```json
{
  "seedCategories": ["工作", "前端", "生活"],
  "userHint": "不要按编程语言分",
  "existingFolders": [{ "ref": "f0", "path": ["工作", "前端"] }],
  "domains": [{ "domain": "github.com", "count": 142, "sampleTitles": ["...", "..."] }],
  "totalBookmarks": 1830,
  "maxDepth": 2,
  "language": "zh"
}
```

本地后处理：

- `existingFolderRef` → 真实文件夹 id（`f*` 映射表在本地）
- 类目按输出顺序重编号为 `c1…cN`，`parentId` 同步改写
- `seedCategories` 若模型漏了，本地补上
- title normalize 后与某个已有文件夹同名但没填 ref 的，自动补 `existingFolderId`
- maxDepth=2 时，只有叶子类目进 assign 列表；有子类的父类目不可被直接分配

System 要点：

- seedCategories 必须全部保留；遵守 userHint
- 复用 existingFolders
- 类目名短、互斥
- 类目要能覆盖绝大多数域名
- 只返回 JSON

### 6.4 Assign

```ts
export const assignSchema = z.object({
  items: z.array(z.object({
    i: z.number().int().nonnegative(),
    categoryId: z.string(),
    confidence: z.enum(['high', 'medium', 'low']),
  })),
});
```

每批 `batchSize` 条，`concurrency` 路并发（默认 2），配 429 退避：

```json
{
  "categories": [{ "id": "c1", "title": "前端", "path": ["工作", "前端"] }],
  "bookmarks": [{ "i": 0, "title": "...", "url": "https://..." }]
}
```

System 要点：

- 只返回 `i` 和 `categoryId`
- `categoryId` 只能是给定 `c*` 或 `uncategorized`
- 禁止复述 URL
- 每批必须覆盖输入的全部 `i`

本地兜底（不重跑整批）：

- `categoryId` 不在叶子类目集合内 → `uncategorized`，`warnings.unknownCategory++`
- 漏掉的 `i` → 补 `uncategorized`，`warnings.missingIndex++`
- 多余 / 重复的 `i` 忽略
- 映射回 `bookmarkId` 在本地做，模型永远看不到真实 id

### 6.5 二轮补类目（refine）

- 触发条件：assign 完成后 `uncategorized + low` 占比 > 20% 且条数 ≥ 10
- 输入：这批书签的域名直方图 + 现有类目列表 + seedCategories / userHint
- 输出：最多 6 个追加类目（可为已有类目的子类目），本地重编号续接 `cN+1…`
- 只对这批书签重新 assign；最多 1 轮
- phase 为 `refining`，进度条继续走

---

## 7. 整理状态机

`src/lib/jobs/organizer.ts` 跑在 **organize 页**，不跑在 background。书签读写直接调 `browser.bookmarks.*`（扩展页有权限），AI 请求也在这页 fetch，不经过 background，少一层消息。background 只做 sidePanel behavior。

```
idle
  → loading-tree
  → proposing
  → assigning   (按 batchSize 分批、concurrency 并发，更新 done/total)
  → refining    (可选，uncategorized 过多时补类目并对其重新 assign)
  → review      (用户可改类目、合并类目、去掉某条、勾选 uncategorized；可带新 userHint 回到 proposing)
  → applying    (备份 + snapshot 落盘 + 串行 move + journal)
  → done
  → error
```

任何阶段可 Cancel：

- proposing / assigning / refining：丢弃未完成批次，不写书签
- applying：停止后续 move，对 `applied` 子集回滚

持久化：每次 phase 变化和每批 assign 完成后写 `local:job`，刷新 organize 页能回到 review，不重打模型。

中断恢复：见 5.3。

新书签自动分类放到 V1.1：background 只监听 `bookmarks.onCreated`，把 id 写入 `local:pending-ids`，organize 页打开时再处理。注意要忽略自己 apply 期间触发的事件（`snapshot.status === 'applying'` 时不记）。

---

## 8. 页面职责

### sidepanel

- 展示书签树（只读 + 搜索过滤）
- 「开始整理」→ `tabs.create(organize.html)`
- 「设置」→ 打开 options
- 显示是否已配置 Key、当前 origin 是否已授权
- 若有可撤销 snapshot，显示撤销按钮；若有中断的 snapshot，显示回滚横幅

### options

- Provider 表单：baseUrl、apiKey、model
- 测试连接（含 `permissions.request`）
- 整理范围、语言、batchSize、并发、仅域名模式、自动备份、debugLimit
- 不在这里跑长任务

### organize（核心）

全屏，分 4 步 wizard：

1. 范围确认：将处理 N 条散装书签；域名直方图；seedCategories 输入（可从已有文件夹勾选）；userHint 输入
2. 生成中：进度条（propose → assign 分批 → refine）
3. 预览：左侧类目，右侧书签；uncategorized 与重复 URL 单独栏，默认不移动；低置信度筛选；可改类目 / 合并 / 剔除；「带提示重新生成」
4. 结果：成功 / 跳过 / 失败数，备份文件名，撤销按钮

这一页持有 job 状态。刷新可从 storage.local 恢复 review 阶段的 proposal，避免重新打模型。

---

## 9. UI 最低集

不引入大组件库。用 Tailwind + 几个 Vue 组件即可。

- 树：缩进列表，文件夹可折叠
- 直方图：横向条形，前 30 个域名
- 预览：两栏
- 进度：确定进度（done/total）
- 表单：原生 input
- 危险操作（应用 / 撤销 / 回滚）要二次确认

颜色保持极简，先能用。

---

## 10. 按这个顺序写（建议 8 个提交，风险优先）

### M0 脚手架（0.5h）

- `wxt init` Vue 模板（临时目录再拷回）
- 配 tailwind、srcDir、manifest permissions / optional_host_permissions / minimum_chrome_version
- 建好 entrypoints 空页面，能 `pnpm dev` 打开 side panel / options / organize

验收：三个页面都能打开，图标点击出 side panel。

### M1 读树（2h）

- `api.ts` + `tree.ts` + `BookmarkTree.vue`
- sidepanel 渲染真实书签
- 正确识别 bookmarks-bar / other、排除 managed、区分双树，统计散装书签数量

验收：自己浏览器里的书签能看见，刷新还在。

### M1.5 内存书签 + snapshot/undo + 性质测试（3h）

在碰模型之前做，这是唯一会弄坏用户数据的部分。

- `fake.ts` 内存实现（见 5.0 语义）
- `mutate.ts` + `snapshot.ts`：apply 带 journal、undo 升序 + clamp、部分回滚，全部只依赖 `BookmarksApi`
- vitest 性质测试（`@webext-core/fake-browser` 不含 bookmarks，自己写；用带种子的 PRNG，失败时打印种子）：
  - 随机生成树（2 根 × 若干文件夹 × 若干散装书签）→ 随机 `ResolvedMove` → apply → undo → 与原树深比较（id、parentId、children 顺序）
  - 第 k 条 move 注入抛错 → 回滚后等于原树
  - 用户在 apply 后往新文件夹里加了一条书签 → undo 后该文件夹保留
  - 跑 200 个随机种子

验收：性质测试全绿。之后 `snapshot.ts` 不再改算法，只接真实 API。

### M2 设置（1.5h）

- `ProviderForm.vue` + `settings.ts`
- 测试连接按钮：`permissions.request` → ping
- sidepanel 未配 Key 时引导去 options

验收：填 DeepSeek / OpenAI / 本地 Ollama 任一端点，ping 成功；拒绝授权时有提示。

### M3 AI 客户端 + Propose（3h）

- `client.ts` + zod + `privacy.ts` + `sampling.ts`
- 用域名直方图 + seedCategories / userHint 跑 propose
- organize 页第 1 步显示直方图，第 3 步能看到类目列表（先不归类）

验收：对真实书签能吐出 8–12 个类目，seed 全部保留，尽量复用已有文件夹名；请求 payload 里没有真实 id、没有 query。

### M4 Assign + 预览（3h）

- 分批 + 并发 assign，兜底计数
- refine 一轮
- 进度条
- `ProposalPreview.vue`：类目 ↔ 书签，可手动改；uncategorized / duplicates 单独栏

验收：500 条以内能跑完，中途断网有 error 态，不写书签；uncategorized 过多时触发 refine。

### M5 接真实写入（2h）

- 用真实 `BookmarksApi` 跑 M1.5 已测过的 apply / undo
- `backup.ts` 应用前自动下载
- 预览确认后才 move

验收：

1. 应用前自动下载了 HTML 备份
2. 应用后结构正确
3. 撤销后结构和整理前一致（新建空文件夹被删）
4. 应用中途关闭 organize 页 → 重开出现回滚横幅 → 回滚后与整理前一致

### M6 打磨（2h）

- job 落 storage.local，整理页刷新能回到 preview
- 错误文案（401 / 429 / Failed to fetch / 模型没返回完整 JSON）
- seedCategories / userHint 的 UI 收口
- 几个默认 baseUrl 预设：OpenAI、DeepSeek、OpenRouter、兼容模式通义、Ollama（`http://localhost:11434/v1`）
- README：本地加载步骤、隐私说明（Key 本地、只发脱敏 title+url）。不写上架相关内容

---

## 11. 关键实现细节（写代码时对照）

1. **模型禁止看到任何真实 id。** 书签用批次内数字 `i`，已有文件夹用 `f*`，类目本地重编号 `c*`，全部在本地 Map 回去。
2. **同名文件夹先查再创建。** normalize 后比较，否则每次整理都会叠一层「前端 (1)」。
3. **撤销 / 回滚按 fromIndex 升序，index clamp 到 children.length。** 降序会越界抛错。apply 阶段移出顺序无关。
4. **新文件夹一律追加到末尾。** 不改动现有兄弟的 index；fromIndex 在建完文件夹、开始 move 之前读取。
5. **串行 move。** 不要 `Promise.all(move)`；journal 需要确定的执行顺序。不做同 parent 内的 move。
6. **Chrome 双树 + managed。** 过滤时看 `folderType` + `syncing`，同一用户可能有两套「书签栏」；`unmodifiable === 'managed'` 整个子树跳过。
7. **snapshot 先落盘再 move。** applying 阶段挂 `beforeunload`；重开页面看到 `status: 'applying'` 就提供回滚。
8. **日志。** `console.debug` 只打 title，不打 apiKey，不打完整 prompt。
9. **temperature 0.2。** 分类要稳，不要每次一套新类目。
10. **uncategorized / duplicates 单独处理。** 预览里单独一栏，默认不移动，除非用户勾选。
11. **先用 debugLimit=20 打通 M3–M5，再开全量。**
12. **所有书签读写走 `BookmarksApi` 接口。** 方便测试注入 fake，也方便以后换 Firefox。
13. **`permissions.request` 必须在用户手势里调用。** 放在「测试连接」按钮的 click handler 里，不要在页面加载时调。

---

## 12. Prompt 草稿（直接可贴）

### Propose system

```
你是书签分类助手。根据书签的域名分布和样例标题，生成稳定、互斥、可复用的文件夹类目。
规则：
- seedCategories 是用户指定的顶层类目，必须全部保留，可在其下补充二级类目
- 遵守 userHint
- 优先复用 existingFolders：类目与某个已有文件夹语义相同时，把它的 ref（如 "f3"）填到 existingFolderRef
- 类目总数 4–12 个，中文短名，最多两层（parentId 指向同一输出里的父类目 id）
- 不要为单一网站建一个类目，除非站点本身就是一个产品线
- 类目要能覆盖绝大多数域名，避免出现只能归入「其他」的大块空白
- 只输出 JSON，shape: { "categories": [{ "id", "title", "parentId?", "existingFolderRef?" }] }
```

### Refine system

```
已有类目列表如下，但仍有一批书签无法归入。根据这批书签的域名分布，补充最多 6 个新类目（可以是已有类目的子类目，parentId 填已有类目 id）。
规则：
- 不要重复已有类目
- 遵守 seedCategories 和 userHint
- 只输出 JSON，shape 与生成类目时相同
```

### Assign system

```
你把书签分到已给定的类目中。
规则：
- 只依据 title 和 url
- categoryId 只能是给定列表中的 id（如 "c3"）或 "uncategorized"
- 只返回 { "items": [{ "i", "categoryId", "confidence" }] }
- items 必须覆盖输入的每一个 i
- 无法判断时 categoryId = "uncategorized"
- 不要输出解释，不要复述 url
```

---

## 13. 验收清单

- [ ] 未配 Key 时不能开始整理
- [ ] 测试连接会弹出该 origin 的授权请求；拒绝后仍可用 CORS 方式尝试并有提示
- [ ] 发出的请求里没有真实 bookmark / 文件夹 id、没有 query / fragment；日志里没有 apiKey
- [ ] 预览阶段不调用 `bookmarks.move`
- [ ] 应用前自动下载了 HTML 备份，且能被 Chrome 书签管理器导入
- [ ] 应用后 Chrome 书签栏 / 其他书签可见新结构；书签栏的散装书签没有跑到「其他书签」
- [ ] 撤销后散装书签回到原文件夹原位置；新建空文件夹被删；用户往新文件夹里手动加的内容保留
- [ ] 应用中途关闭 organize 页 → 重开有回滚横幅 → 回滚后与整理前一致
- [ ] 刷新 organize 页不丢失 preview
- [ ] 401 提示「Key 无效」，429 提示「限速，请稍后」，Failed to fetch 提示「CORS / 未授权 origin」
- [ ] 性质测试：200 个随机种子下 apply → undo 恒等于原树
- [ ] managed 书签不出现在整理范围

---

## 14. 下一步怎么开写

```bash
cd /home/pax/Project/front_project/shelfmark
pnpm dlx wxt@latest init .tmp-init --template vue --pm pnpm
cp -a .tmp-init/. . && rm -rf .tmp-init
pnpm install
pnpm add zod tldts
pnpm add -D tailwindcss @tailwindcss/vite vitest
pnpm dev
```

先把 M0 + M1 + M1.5 做完：三个空页面 + 真实书签树 + 在内存里验证过的 apply / undo。树能显示、撤销算法有测试兜底，后面所有模块都有地方挂、也不怕弄坏数据。
