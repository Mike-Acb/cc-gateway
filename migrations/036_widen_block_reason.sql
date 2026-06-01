BEGIN;

-- 008 migration 把 block_reason 定为 VARCHAR(32),后续新增的 BlockReason 字面量
-- (尤其 'shape_forbidden_after_auto_complete' = 36 字符) 超出限制,触发
-- "value too long for type character varying(32)";insert + update 双双失败,
-- 客户端虽收到正确 4xx,但 request_logs 里没有对应行,UI 表现为"日志丢失"。
--
-- 实测过去 24h 仅 gwbk 一个环境就有 290+ 条 shape_forbidden_after_auto_complete
-- 因此被丢日志。扩到 VARCHAR(64) 留充分余量(目前最长字面量 36,翻倍预留)。
--
-- 对应代码:src/request-logger.ts BlockReason 联合类型新增条目时不必再改 schema。

ALTER TABLE request_logs ALTER COLUMN block_reason TYPE VARCHAR(64);

DO $$
DECLARE actual_len INT;
BEGIN
  SELECT character_maximum_length INTO actual_len
    FROM information_schema.columns
   WHERE table_name = 'request_logs' AND column_name = 'block_reason';
  IF actual_len IS DISTINCT FROM 64 THEN
    RAISE EXCEPTION 'block_reason 扩列后应为 VARCHAR(64),实际 %', actual_len;
  END IF;
END $$;

COMMIT;
