-- 038_usage_records_multiplier.sql
-- usage_records.cost 列存的是「乘了 group 倍率之后」的网关计费金额(用户视角)。
-- 但运营经常需要同时看「官方 1× 原价」和「计费价」做对账,目前只能反推 multiplier,
-- 不方便。加一列 billing_multiplier 把当时使用的倍率一起落库,detail API 可以
-- 一次性算出 cost_official = cost / multiplier。
--
-- 默认 1.000 (官方价 = 计费价),老数据回填 1.000:历史 cost 已经是乘后值,无法
-- 反推真实倍率(分组 cost_multiplier 是可调的,且账号可能换过分组),只能假设
-- = 1.000。新写入会落正确值。这对运营对账"从此刻开始准确"。

BEGIN;

ALTER TABLE usage_records
  ADD COLUMN IF NOT EXISTS billing_multiplier NUMERIC(6,3) NOT NULL DEFAULT 1.000;

COMMIT;
