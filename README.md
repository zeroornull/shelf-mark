# Shelfmark

用 AI 预览并整理 Chrome 书签文件夹的浏览器扩展。读取你的书签树，让一个 OpenAI-compatible 模型提出类目、把散装书签归类，你在预览里改到满意后再一键写回 Chrome 原生文件夹。写入前自动下载 HTML 备份，写入后可一键撤销；中途断掉也能回滚。

自用 / 小范围分享定位，以开发者模式加载，不上架。

## 要求

- Chrome 或 Edge **≥ 134**（依赖 `bookmarks` API 的 `folderType` / `syncing` 字段来识别书签栏、其他书签和账号 / 本地双树；低版本会拒绝安装）
- Node.js ≥ 20 与 pnpm（仅构建时需要）
- 一个 OpenAI-compatible 的接口：OpenAI、DeepSeek、OpenRouter、通义（兼容模式）、本地 Ollama / LM Studio 等

## 本地安装

```bash
pnpm install
pnpm build          # 产物在 .output/chrome-mv3
```

Chrome → `chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选择 `.output/chrome-mv3`。

开发时可以用 `pnpm dev`，WXT 会启动一个带热更新的浏览器实例。

点击扩展图标打开 side panel；side panel 里有「设置」和「开始整理」。

## 配置 Provider

设置页（side panel 的「设置」或扩展的「选项」）填三项：

| 字段 | 说明 |
| --- | --- |
| `baseUrl` | 到 `/v1` 为止，例如 `https://api.openai.com/v1`；请求会发到 `{baseUrl}/chat/completions` |
| `apiKey` | 只保存在本机 `storage.local`；本地模型可随便填一个占位值 |
| `model` | 例如 `gpt-4o-mini`、`deepseek-chat`、`qwen-plus`、`qwen2.5:7b` |

预设下拉里有 OpenAI、DeepSeek、OpenRouter、通义（兼容模式）、Ollama（`http://localhost:11434/v1`）几个常用 `baseUrl`，模型名仍需自己填。

**测试连接**：点击后浏览器会弹出「允许访问 `<你的 baseUrl 的 origin>`」的授权请求，然后发一条 `ping`。

- 安装时不申请任何网站权限；`manifest` 里只有 `optional_host_permissions`，「测试连接」只为你填的那一个 origin 申请（Chrome 要求这类请求在用户点击里发起，所以放在按钮上）。
- 拒绝授权也能用，但请求会走浏览器的 CORS 规则：OpenAI / DeepSeek 等公开接口一般允许，本地模型和中转站往往不允许，表现为「Failed to fetch」。
- Ollama / LM Studio：`http://localhost/*` 已在可选权限列表里（任意端口）。Ollama 默认只监听 `127.0.0.1:11434`，用 `http://localhost:11434/v1` 或 `http://127.0.0.1:11434/v1` 都行；若浏览器报 403，把 Ollama 的 `OLLAMA_ORIGINS` 设为包含 `chrome-extension://*`。
- 推理类模型拒绝 `temperature` / `max_tokens` / `response_format` 时会自动去掉该字段重试一次。

其余设置：整理范围（只整理「其他书签」的散装书签，或加上书签栏的散装书签）、文件夹层数（1 或 2）、类目语言、每批条数、并发、仅域名模式、是否自动备份、默认 `seedCategories` / `userHint`，以及打通流程用的 `debugLimit`（只处理前 N 条，建议先用 20 试跑）。

## 整理流程

整理在一个全屏页里分四步进行：

1. **范围确认**：显示将处理的散装书签数量、域名分布；可预填顶层类目（也能从已有文件夹里勾选）和一句话偏好。
2. **生成中**：模型先按域名分布提出类目（优先复用你已有的文件夹），再分批归类；未分类过多时补一轮类目。随时可取消，此阶段不写任何书签。
3. **预览**：左侧类目、右侧书签。可以改某条的类目、合并 / 重命名类目、剔除某条、带新提示重新生成。「未分类」和「重复 URL」单独一栏，默认不移动，勾选后才动。
4. **应用与结果**：确认后先自动下载 HTML 备份，然后串行移动书签（每移一条记一条日志）。完成后显示成功 / 跳过条数、备份文件名和「撤销」按钮。

写入规则：优先复用同名文件夹（忽略大小写、全半角、首尾空白），新文件夹追加到末尾，书签栏和「其他书签」各归各根、不跨根移动，已有的命名文件夹不拆，「书签栏 / 其他书签 / 移动书签」根节点本身不改。企业策略书签不进整理范围。

**撤销**：结果页和 side panel 都有「撤销最近一次整理」。按原来的父文件夹和位置把书签移回去；本次新建的空文件夹删除，你在里面手动放了东西的保留。

**中断回滚**：应用过程中关闭页面会先弹出确认。若页面还是被关掉（或崩溃），下次打开整理页或 side panel 会看到「上次整理被中断，已移动 N/M」横幅，点「回滚」即可把已移动的部分移回原位。V1 不做「继续执行」。

## 隐私

- API Key 只写入 `chrome.storage.local`，不进 `storage.sync`，不上传到任何地方；请求直接从浏览器发到你填的 `baseUrl`。
- 发给模型的只有：**打码后的标题**（邮箱替换为 `[email]`，截断到 120 字）、**清洗后的 URL**（去掉 query 和 fragment，路径最多 3 段；「仅域名模式」下只发 hostname）、**已有文件夹的标题路径**、域名统计和数量。
- 书签和文件夹用批次内的临时编号（`i`、`f0`、`c1`）指代，**真实 Chrome id 从不出现在请求里**。
- 没有 content script，不申请 `<all_urls>` 或 `tabs`，不读网页内容，不抓正文。
- 日志里只有阶段和条数，不打印 Key 和 prompt。

## 安全模型

- **先预览再写**：预览阶段只调用读接口，一次 `bookmarks.move` 都不发。
- **snapshot + journal**：写入前把每条书签的原父文件夹和位置记下来并落盘，之后串行移动，每成功一条追加一条日志。任何一条失败都会对已移动的子集回滚。
- **撤销**：基于 snapshot 按原位置恢复，index 会按当前子节点数裁剪，用户期间删过书签也不会越界。只用 `bookmarks.remove` 删空文件夹，绝不 `removeTree`。
- **HTML 备份**：Netscape Bookmark File 格式，Chrome 书签管理器右上角菜单「导入书签」可直接读入，是撤销之外的第二道保险。
- 200 个随机种子的性质测试保证 apply → undo 恒等于原树；第 k 条失败回滚后也等于原树。

## V1 不做

账号 / 后端、抓网页正文、失效链接扫描、静默自动移动、语义向量搜索、Firefox 优先适配、改动根节点、勾选任意文件夹作为范围、中断后「继续执行」、上架相关内容（商店文案、多语言、权限警告优化）。

## 开发

```bash
pnpm test        # vitest：书签层 / AI 层 / 状态机 / 备份 / 文案
pnpm compile     # vue-tsc --noEmit
pnpm build       # 产出 .output/chrome-mv3
pnpm dev         # 带热更新的开发模式
```

约定：`src/lib/**` 里只有 `bookmarks/api.ts`、`settings.ts`、`jobs/store.ts` 允许 import `wxt/*` / `browser`；其余模块通过参数接收 `BookmarksApi`、持久化函数和 `fetch`，因此测试在 Node 里直接跑，书签写入用内存实现的 `fake.ts` 复刻 Chrome 的 index 语义。

实现计划与验收清单见 [`bookmark-ai-plan.md`](./bookmark-ai-plan.md)。
