-- Retired: this migration declared the observation sequence on the connector event index.
--
-- The index moved to the package that has connectors. Three of the four consumers
-- of this core have none, and were running these statements against tables they
-- never write. The schema is declared whole in standalone/db/migrations/001.
--
-- The file stays, and the number stays claimed: databases in the field recorded
-- 62 as applied, and a number that comes back meaning something else is worse
-- than a number that means nothing.

