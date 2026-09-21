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
