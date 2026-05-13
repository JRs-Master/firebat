/**
 * Form validation utility — Phase 8 정공 (2026-05-13).
 *
 * 옛 산재된 manual form validation (login / SetupWizard / settings / 등) → zod schema 통합.
 *
 * 패턴:
 *   import { z } from 'zod';
 *   import { validateForm } from '@/lib/form-validation';
 *
 *   const schema = z.object({
 *     id: z.string().min(1, '아이디를 입력하세요'),
 *     password: z.string().min(8, '비밀번호는 8자 이상').max(128),
 *   });
 *
 *   const result = validateForm(schema, formData);
 *   if (result.success) {
 *     // submit result.data (type-safe)
 *   } else {
 *     // result.errors: Record<field, message>
 *   }
 *
 * 단일 필드 검증 (실시간 input):
 *   import { validateField } from '@/lib/form-validation';
 *   const err = validateField(schema.shape.password, value);
 *   if (err) showInlineError(err);
 */

import type { ZodSchema, ZodTypeAny } from 'zod';

export type FormValidationResult<T> =
  | { success: true; data: T }
  | { success: false; errors: Record<string, string> };

/** zod schema 으로 form data 검증. 실패 시 field → 에러 메시지 매핑. */
export function validateForm<T>(schema: ZodSchema<T>, input: unknown): FormValidationResult<T> {
  const result = schema.safeParse(input);
  if (result.success) return { success: true, data: result.data };
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    if (!errors[key]) errors[key] = issue.message;
  }
  return { success: false, errors };
}

/** 단일 필드 검증 — 실시간 input onChange 핸들러 용. 첫 에러 메시지 반환. */
export function validateField(schema: ZodTypeAny, value: unknown): string | null {
  const result = schema.safeParse(value);
  if (result.success) return null;
  return result.error.issues[0]?.message ?? '유효하지 않은 값입니다.';
}
