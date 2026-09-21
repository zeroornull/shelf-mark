<script lang="ts" setup>
import { computed, ref } from 'vue';
import type { FlatBookmark, FolderNode } from '@/lib/types';
import { isFolderNode } from '@/lib/bookmarks/tree';

/**
 * 只读书签树：缩进列表，文件夹可折叠，支持按标题 / URL 过滤。
 * 渲染成扁平的行列表（而不是递归组件），大树也不需要深层组件嵌套。
 */
const props = defineProps<{
  /** 各根节点的 FolderNode。 */
  nodes: FolderNode[];
  /** 过滤词，空串表示不过滤。 */
  filter?: string;
}>();

type Row =
  | { kind: 'folder'; id: string; depth: number; title: string; count: number; expanded: boolean }
  | { kind: 'bookmark'; id: string; depth: number; title: string; url: string };

/** 用户手动切换过的文件夹展开状态；未记录的按默认值（根展开、子文件夹折叠）。 */
const expandedOverrides = ref(new Map<string, boolean>());

function isExpanded(id: string, depth: number): boolean {
  return expandedOverrides.value.get(id) ?? depth === 0;
}

function toggle(id: string, depth: number): void {
  const next = new Map(expandedOverrides.value);
  next.set(id, !isExpanded(id, depth));
  expandedOverrides.value = next;
}

const bookmarkCounts = computed(() => {
  const counts = new Map<string, number>();
  const count = (folder: FolderNode): number => {
    let total = 0;
    for (const child of folder.children) total += isFolderNode(child) ? count(child) : 1;
    counts.set(folder.id, total);
    return total;
  };
  for (const root of props.nodes) count(root);
  return counts;
});

const query = computed(() => (props.filter ?? '').trim().toLowerCase());

function matchesBookmark(bookmark: FlatBookmark, q: string): boolean {
  return bookmark.title.toLowerCase().includes(q) || bookmark.url.toLowerCase().includes(q);
}

const rows = computed<Row[]>(() => {
  const q = query.value;
  const filtering = q !== '';

  const visitFolder = (folder: FolderNode, depth: number): Row[] => {
    const expanded = filtering || isExpanded(folder.id, depth);
    const childRows: Row[] = [];
    if (expanded) {
      for (const child of folder.children) {
        if (isFolderNode(child)) {
          childRows.push(...visitFolder(child, depth + 1));
        } else if (!filtering || matchesBookmark(child, q)) {
          childRows.push({ kind: 'bookmark', id: child.id, depth: depth + 1, title: child.title, url: child.url });
        }
      }
    }
    const selfMatches = !filtering || folder.title.toLowerCase().includes(q);
    if (filtering && childRows.length === 0 && !selfMatches) return [];
    return [
      {
        kind: 'folder',
        id: folder.id,
        depth,
        title: folder.title === '' ? '（未命名文件夹）' : folder.title,
        count: bookmarkCounts.value.get(folder.id) ?? 0,
        expanded,
      },
      ...childRows,
    ];
  };

  return props.nodes.flatMap((root) => visitFolder(root, 0));
});

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
</script>

<template>
  <ul class="text-sm leading-5">
    <li
      v-for="row in rows"
      :key="row.id"
      class="flex min-w-0 items-center gap-1 py-0.5"
      :style="{ paddingLeft: `${row.depth * 12 + 4}px` }"
    >
      <template v-if="row.kind === 'folder'">
        <button
          type="button"
          class="w-4 shrink-0 text-gray-500 hover:text-gray-900"
          :aria-expanded="row.expanded"
          :disabled="query !== ''"
          @click="toggle(row.id, row.depth)"
        >
          {{ row.expanded ? '▾' : '▸' }}
        </button>
        <span class="truncate font-medium text-gray-800">{{ row.title }}</span>
        <span class="shrink-0 text-xs text-gray-400">{{ row.count }}</span>
      </template>
      <template v-else>
        <span class="w-4 shrink-0 text-center text-gray-300">•</span>
        <span class="truncate text-gray-700" :title="row.url">{{ row.title || row.url }}</span>
        <span class="shrink-0 truncate text-xs text-gray-400">{{ hostOf(row.url) }}</span>
      </template>
    </li>
    <li v-if="rows.length === 0" class="px-1 py-2 text-gray-400">
      {{ query !== '' ? '没有匹配的书签' : '没有书签' }}
    </li>
  </ul>
</template>
