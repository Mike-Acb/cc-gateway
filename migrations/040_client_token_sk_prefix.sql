-- 040_client_token_sk_prefix.sql
-- 放宽 clients.token 长度限制，便于使用 'sk-' 前缀的明文 token。
-- 原 CHAR(64) 会对短于 64 的值进行空格右填充，导致 'sk-...' 前缀 token
-- 在请求头精确匹配时失败。改为 VARCHAR(128)，长度足够、不再空格填充。

ALTER TABLE clients
  ALTER COLUMN token TYPE VARCHAR(128);
