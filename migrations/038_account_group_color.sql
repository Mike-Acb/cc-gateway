-- 038_account_group_color.sql
-- 给 account_groups 加 color 字段(调色板 key,如 'slate' / 'plum'),
-- NULL 表示未显式指定,前端按组名哈希落到调色板。
-- VARCHAR(16) 留余量,真实只允许 web/src/ui/groupPalette.ts 的固定枚举。
BEGIN;

ALTER TABLE account_groups
  ADD COLUMN IF NOT EXISTS color VARCHAR(16);

COMMIT;
