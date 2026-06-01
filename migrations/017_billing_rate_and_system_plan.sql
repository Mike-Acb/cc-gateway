-- 017: 充值汇率 + 系统补偿 plan
--
-- ① system_settings 增加 cny_to_usd_rate（默认 1.0）
--    所有 CNY → USD 换算（quota 入账、降级差价）都从这里读。
-- ② plans 增加 is_system 列
--    标记系统内部 plan，不出现在用户购买/管理员编辑面板。
-- ③ 预置系统补偿 plan（type=quota, enabled=false）
--    承载"降级差价、运营补偿"等没有现成 quota 接收方的场景。

BEGIN;

INSERT INTO system_settings (key, value, updated_at)
VALUES ('cny_to_usd_rate', '1.0', now())
ON CONFLICT (key) DO NOTHING;

ALTER TABLE plans ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;

INSERT INTO plans (
  id, name, type, price, currency, quota_amount,
  is_system, enabled, sort_order, description
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '系统补偿',
  'quota',
  0,
  'CNY',
  0,
  true,
  false,
  9999,
  '系统预置：承载降级差价、运营补偿等场景的额度归集点，不可购买或编辑。'
) ON CONFLICT (id) DO NOTHING;

COMMIT;
