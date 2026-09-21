import { z } from 'zod';

/** 计划 §6.3：模型输出的类目。`id` 只在本次输出内部用于 parentId 引用，落地前重编号。 */
export const taxonomySchema = z.object({
  categories: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        title: z.string().min(1).max(20),
        parentId: z.string().optional(),
        existingFolderRef: z.string().regex(/^f\d+$/).optional(),
      }),
    )
    .min(4)
    .max(16),
});

export type TaxonomyOutput = z.infer<typeof taxonomySchema>;
export type RawCategory = TaxonomyOutput['categories'][number];

/**
 * refine 阶段的输出 shape 与 propose 相同，但数量约束不同：追加 0–6 个。
 * 模型偶尔会多给，超出部分本地截断，所以上限放宽到 16 由本地兜底。
 */
export const refineSchema = z.object({
  categories: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        title: z.string().min(1).max(20),
        parentId: z.string().optional(),
        existingFolderRef: z.string().regex(/^f\d+$/).optional(),
      }),
    )
    .max(16),
});

/** 计划 §6.4：批量归类输出。`i` 是批次内的本地序号。 */
export const assignSchema = z.object({
  items: z.array(
    z.object({
      i: z.number().int().nonnegative(),
      categoryId: z.string(),
      confidence: z.enum(['high', 'medium', 'low']),
    }),
  ),
});

export type AssignOutput = z.infer<typeof assignSchema>;
