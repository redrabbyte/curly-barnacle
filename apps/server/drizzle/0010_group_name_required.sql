-- Every group now carries its name sealed (design §4.2): the columns 0009
-- added are required, and the readable one it left behind is dropped.
--
-- Self-guarding: MySQL refuses MODIFY ... NOT NULL while any row is still null
-- (ERROR 1138) and changes nothing, so running this before every group has
-- been sealed fails loudly instead of coercing anything to an empty string —
-- and the DROP comes last, so a refusal never takes a readable name away from
-- a group that has no sealed one yet.
--
-- DDL is not transactional in MySQL, so a refusal can leave the earlier
-- statements applied. Each one is idempotent — a column already NOT NULL is a
-- no-op — so the fix is to let the remaining groups sync once and run this
-- again. A group whose members never sync again is the operator's call:
-- `select id from groups where name_ct is null` names them.
ALTER TABLE `groups` MODIFY COLUMN `name_epoch` int NOT NULL;--> statement-breakpoint
ALTER TABLE `groups` MODIFY COLUMN `name_iv` varchar(32) NOT NULL;--> statement-breakpoint
ALTER TABLE `groups` MODIFY COLUMN `name_ct` varchar(768) NOT NULL;--> statement-breakpoint
ALTER TABLE `groups` DROP COLUMN `name`;
