import { storage } from 'wxt/utils/storage';
import type { OrganizeJob, Snapshot } from '../types';

/**
 * job / snapshot 持久化（计划 §4）：都进 `storage.local`，V1 只保留 1 个 job 和 1 份 snapshot。
 * 这是 `jobs/` 下唯一允许 import `wxt/*` 的文件；`organizer.ts` 通过注入的 `persistJob` 写入。
 */

export const jobStorage = storage.defineItem<OrganizeJob | null>('local:job', { fallback: null });

export const snapshotStorage = storage.defineItem<Snapshot | null>('local:snapshot', { fallback: null });

/** 给 organizer 注入用：null → 清掉。 */
export async function persistJobToStorage(job: OrganizeJob | null): Promise<void> {
  if (job === null) await jobStorage.removeValue();
  else await jobStorage.setValue(job);
}
