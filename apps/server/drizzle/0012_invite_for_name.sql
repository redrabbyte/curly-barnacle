-- A link can now be made *for* a name (design §4.4). The inviter can see the
-- ledger and knows which entries are whose; the person following the link
-- cannot, and used to have to find themselves in a list of strangers' names
-- in the ten seconds after tapping it. Null keeps the old behaviour: the
-- follower is asked.
ALTER TABLE `invites` ADD `claim_member_id` char(36);
