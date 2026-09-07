-- The group name moves to the sealed side (design §4.2).
--
-- It was the one thing members wrote that this server could read. It stayed
-- readable so the invite landing page could name the group to a stranger who
-- holds no key; the inviter's own device puts the name in the link fragment
-- now, which never reaches a server, so nothing here needs it any more.
--
-- The server cannot seal anything. Three nullable columns are added and the
-- old one made nullable, and the clients do the rest: a member holding the
-- group's newest epoch seals the name on their next sync, first writer wins,
-- and the readable copy is nulled in the same statement. `name_epoch` stays
-- plain so the server can insist a name is under the newest epoch without
-- being able to open it.
--
-- The activity log kept a readable copy in every `group.created` payload.
-- That is data nothing reads — the feed says "created the group" and never
-- the name — so it is removed here rather than left for a dump to find.
-- JSON_REMOVE on a row without the key is a no-op, so re-running is safe.
--
-- The follow-up is 0010, the same shape as 0006: once every group has been
-- sealed (`select id from groups where name_ct is null` comes back empty) it
-- makes the sealed columns required and drops the readable one. Kept apart
-- from this file deliberately: MySQL refuses MODIFY ... NOT NULL while any
-- row is null, and a group whose members never sync again would leave it
-- refusing forever. That is an operator's decision, taken when the count is
-- known, not one a migration can make.
ALTER TABLE `groups` MODIFY COLUMN `name` varchar(120);--> statement-breakpoint
ALTER TABLE `groups` ADD `name_epoch` int;--> statement-breakpoint
ALTER TABLE `groups` ADD `name_iv` varchar(32);--> statement-breakpoint
ALTER TABLE `groups` ADD `name_ct` varchar(768);--> statement-breakpoint
UPDATE `activity` SET `payload` = JSON_REMOVE(`payload`, '$.name') WHERE `type` = 'group.created';
