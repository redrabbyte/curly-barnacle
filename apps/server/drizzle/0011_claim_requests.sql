-- A join request is no longer only about joining: somebody already in the
-- group can ask to take over one of its names, which is the same decision for
-- the same admin and so belongs in the same queue (design §5).
--
-- `kind` joins the primary key rather than sitting beside it. A member who
-- joined months ago still has their decided row, and asking about a name has
-- to be a second row — overwriting the first would erase how they got in.
--
-- Written in this order deliberately: the generated version added the key
-- before the column it names. The column comes first, with a default, so every
-- existing row is a `join` — which is what all of them are — and the key swap
-- is one statement, so the table is never without a primary key.
ALTER TABLE `join_requests` ADD `kind` varchar(16) DEFAULT 'join' NOT NULL;--> statement-breakpoint
ALTER TABLE `join_requests` DROP PRIMARY KEY, ADD PRIMARY KEY(`group_id`,`user_id`,`kind`);--> statement-breakpoint
-- Null for a claim: it is asked from inside the group, so there is no
-- capability behind it and no digits for an admin to read out.
ALTER TABLE `join_requests` MODIFY COLUMN `invite_token_hash` varchar(64);
