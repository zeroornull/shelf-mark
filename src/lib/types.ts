// src/lib/types.ts

export type ProviderConfig = {
  baseUrl: string;   // 例 https://api.openai.com/v1
  apiKey: string;
  model: string;     // 例 gpt-4o-mini / deepseek-chat
};

export type Settings = {
  provider: ProviderConfig;
  scope: 'loose-other' | 'loose-bar-and-other';   // 'selected' 放 V1.1
  includeFoldered: boolean;   // 已在文件夹里的书签也进整理范围，默认 true
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

/** 制定计划时每条书签的位置；刷新恢复用它判断「parentId 未变」，不能再用「仍是散装」。 */
export type BookmarkOrigin = {
  parentId: string;
  rootId: string;
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

// 步骤 1 确认的输入；刷新恢复与「带提示重新生成」用（scope / maxDepth 等仍取自 settings）
export type JobInput = {
  seedCategories: string[];
  userHint: string;
  includeFoldered?: boolean;
};

// review 阶段的人工编辑，随 job 一起落盘
export type ReviewState = {
  excluded: string[];            // 用户剔除的 bookmarkId，不移动
  includeUncategorized: boolean; // 勾选后 uncategorized 条目移入「未分类」文件夹；默认 false
  includeDuplicates: boolean;    // 勾选后重复 URL 的条目也按类目移动；默认 false
};

// 撤销 / 回滚的结果摘要（restoreSnapshot 的计数 + 触发原因），结果页显示「已恢复 N/M」
export type RestoreSummary = {
  reason: 'undo' | 'failure' | 'cancel' | 'interrupted';
  total: number;            // 尝试恢复的条数（= applied 子集大小）
  restored: number;         // 回到原文件夹
  skipped: number;          // 书签已被用户删除
  relocated: number;        // 原文件夹已不存在，移到对应根节点末尾
  failed: number;           // move 意外失败
  removedFolders: number;   // 删掉的空新建文件夹
  keptFolders: number;      // 非空而保留的新建文件夹
};

export type OrganizeJob = {
  id: string;
  phase: JobPhase;
  total: number;            // applying / done 阶段 = 本次实际要移动的条数
  done: number;             // applying / done 阶段 = 已成功移动的条数
  proposal?: Proposal;
  snapshotId?: string;
  skipped: Array<{ bookmarkId: string; reason: string }>;   // apply 前校验被剔除的
  error?: string;
  input?: JobInput;
  review?: ReviewState;
  backupFileName?: string;  // §5.3 第 0 步下载的备份文件名；未备份时为空
  restore?: RestoreSummary; // 撤销 / 回滚过一次之后有值
  /** 范围内每条书签在制定计划时的 parentId + rootId；restore / resolveMoves 用。 */
  origins?: Record<string, BookmarkOrigin>;
  /** 应用后变空的、非本次新建的用户文件夹（只报告，绝不自动删除）。 */
  emptiedFolders?: Array<{ id: string; path: string[] }>;
};
